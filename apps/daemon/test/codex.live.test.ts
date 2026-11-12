import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { mintId, Provider, type AccountId, type SessionId } from '@10db/contracts';
import type { AccountRow } from '@10db/db';
import { parse } from 'smol-toml';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv } from '../src/env';
import {
  AgentTool,
  captureLoginEnv,
  createLauncher,
  ensureAgent,
  type Launcher,
} from '../src/environment';
import { createGit } from '../src/git';
import { createLogger } from '../src/log';
import { resolveSandboxRuntime } from '../src/paths';
import { openSandboxRoots, sandboxDepsOf, type SandboxRoots } from '../src/daemon';
import {
  claimSandboxRoots,
  createLaneSandbox,
  type LaneSandbox,
  type LaneSessionInput,
  type SetupInput,
} from '../src/sandbox';
import {
  createCodexAdapter,
  guardSocketPath,
  patchPaths,
  spawnAppServer,
  type CodexChild,
  type SessionAdapter,
  type SessionEvent,
  type SessionSpec,
  type ShapeImage,
} from '../src/sessions';
import {
  startFakeResponses,
  type FakeRequest,
  type FakeResponses,
  type FakeStep,
} from './fake-responses';
import { createMemoryKeychain, isolatedGitEnv, TEST_REPO_CONFIG } from './fixtures';
import { noisePng } from './png';

const live = loadEnv(process.env).TENDB_LIVE_CODEX === '1';

/**
 * Every directory a live test makes is one of these, in `~/.10db/`: under `/private/tmp` Codex's
 * sandbox gives false results.
 */
const LIVE_PARENT = join(homedir(), '.10db');
const LIVE_PREFIX = 'codex-live-';

/** The model the lane launches on; the fake model answers any. */
const MODEL = 'gpt-5.6-sol';

/** Who the stand-in says the account is: no real account is ever signed in. */
const STAND_IN = { email: 'live@example.invalid', workspace: 'ws-live' } as const;

/**
 * The tools a lane's model is offered on the verified Codex (`CODEX_VERIFIED_ON`), by name, as the fake model records them: code
 * mode's `exec` and the tools its scripts call.
 */
const OFFERED_TOOLS: readonly string[] = [
  'functions.exec',
  'functions.request_user_input',
  'functions.wait',
];
const EXEC_TOOLS: readonly string[] = [
  'apply_patch',
  'exec_command',
  'list_mcp_resource_templates',
  'list_mcp_resources',
  'read_mcp_resource',
  'view_image',
  'write_stdin',
];

/** What the guard refuses, so a script can ask for a refusal by naming it. */
const DENIED = 'DENYME';
const DENIAL_REASON = 'the live test refused this call';

/** Removes a directory this file made, and only such a directory: never a link, never another path. */
function removeLiveDir(path: string): void {
  const parent = realpathSync(LIVE_PARENT);
  const entry = lstatSync(path);
  if (dirname(path) !== parent || !path.slice(parent.length + 1).startsWith(LIVE_PREFIX))
    throw new Error(`not a live test directory: ${path}`);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`not a directory: ${path}`);
  rmSync(path, { recursive: true });
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), encoding: 'utf8' });
}

/** A repository with one commit and git's background maintenance off. */
function initRepo(dir: string): void {
  mkdirSync(dir);
  gitIn(dir, 'init', '-q', '-b', 'main');
  for (const [key, value] of Object.entries(TEST_REPO_CONFIG)) gitIn(dir, 'config', key, value);
  gitIn(dir, 'config', 'user.name', '10db test');
  gitIn(dir, 'config', 'user.email', 'test@10db.invalid');
  gitIn(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  gitIn(dir, 'add', 'README.md');
  gitIn(dir, 'commit', '-q', '-m', 'Initial commit');
}

/** A file holding a random token that must never reach a lane. */
function plant(path: string): string {
  const token = `canary-${randomUUID()}`;
  writeFileSync(path, `${token}\n`);
  return token;
}

/** Code-mode JavaScript that awaits one tool call and reports what it returned, or what it threw. */
const codeMode = (call: string): FakeStep => ({
  js: `try { const r = await ${call}; text(JSON.stringify(r)); } catch (e) { text('threw: ' + String(e)); }`,
});
const run = (cmd: string): FakeStep =>
  codeMode(`tools.exec_command({ cmd: ${JSON.stringify(cmd)} })`);
const patch = (body: string): FakeStep => codeMode(`tools.apply_patch(${JSON.stringify(body)})`);
/** 10db's own `commit` tool, as a lane calls it. */
const commit = (message: string): FakeStep =>
  codeMode(`tools.mcp__10db__commit({ message: ${JSON.stringify(message)} })`);

/**
 * A curl that prints the page and `label=<status>`, which only a request that reached the host
 * fills in. Every host it asks serves the page that holds `EXAMPLE_PAGE`, a POST included.
 */
const curl = (label: string, url: string, opts: { readonly post?: boolean } = {}): string =>
  `curl -sS -m 20 ${opts.post === true ? '-X POST -d probe=1 ' : ''}-w ' ${label}=%{http_code}' ${url}`;

/** What the IANA example domains' page holds, whatever the method or status. */
const EXAMPLE_PAGE = '<title>Example Domain</title>';

/** What Codex says, in a call's JSON output, of a command whose request to `host` it blocked. */
const blocked = (host: string): string => `Network access to \\"${host}\\" was blocked`;

/** How long a `codex` the test ended may take to exit. */
const EXIT_DEADLINE_MS = 15_000;

const addFile = (path: string, line: string): string =>
  `*** Begin Patch\n*** Add File: ${path}\n+${line}\n*** End Patch\n`;

// ---------------------------------------------------------------------------------------------
// The 10db MCP server, as far as a lane calls it: a `commit` tool behind the session's token.

interface FakeMcp {
  readonly url: string;
  /** The arguments of every `tools/call` that reached the server. */
  readonly calls: string[];
  close(): Promise<void>;
}

const McpRequest = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
  params: z.looseObject({}).optional(),
});

async function readBody(req: IncomingMessage): Promise<string> {
  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
}

async function startFakeMcp(token: string): Promise<FakeMcp> {
  const calls: string[] = [];
  const reply = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    if (req.headers.authorization !== `Bearer ${token}`) {
      reply(res, 401, {});
      return;
    }
    if (req.method !== 'POST') {
      reply(res, 405, {});
      return;
    }
    const message = McpRequest.parse(JSON.parse(body));
    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const result = (): unknown => {
      switch (message.method) {
        case 'initialize':
          return {
            protocolVersion: message.params?.['protocolVersion'] ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: '10db', version: '0' },
          };
        case 'tools/list':
          return {
            tools: [
              {
                name: 'commit',
                description: 'Commits the lane’s work.',
                inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
              },
            ],
          };
        case 'tools/call':
          calls.push(JSON.stringify(message.params?.['arguments'] ?? {}));
          return { content: [{ type: 'text', text: 'committed' }] };
        default:
          return null;
      }
    };
    const answer = result();
    reply(
      res,
      200,
      answer === null
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } }
        : { jsonrpc: '2.0', id: message.id, result: answer },
    );
  };
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  // A listening TCP server's address is always an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    calls,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// The account, at the process boundary: real Codex runs with no login, on the fake model.

const RpcLine = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  result: z.looseObject({}).optional(),
});

/** Calls `onLine` with each line of `stream` (split at "\n" only, as 10db's client does). */
function eachLine(stream: Readable, onLine: (line: string) => void, onEnd: () => void): void {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.length > 0) onLine(line);
    }
  });
  stream.on('end', onEnd);
}

/**
 * The real `codex app-server`, signed in to nothing, between 10db and which the stand-in answers who
 * the account is: `account/read` goes to Codex, which must accept 10db's params, and comes back
 * naming a ChatGPT account; `account/rateLimits/read` is answered here with the workspace. Nothing
 * else is touched.
 */
function withStandInAccount(child: CodexChild): CodexChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const accountReads = new Set<number | string>();
  child.stdin.on('error', () => undefined);
  const out = (message: unknown): void => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };
  eachLine(
    stdin,
    (line) => {
      const message = RpcLine.parse(JSON.parse(line));
      if (message.method === 'account/rateLimits/read' && message.id !== undefined) {
        out({
          id: message.id,
          result: {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: null },
            },
            accountId: STAND_IN.workspace,
          },
        });
        return;
      }
      if (message.method === 'account/read' && message.id !== undefined)
        accountReads.add(message.id);
      child.stdin.write(`${line}\n`);
    },
    () => child.stdin.end(),
  );
  eachLine(
    child.stdout,
    (line) => {
      const message = RpcLine.parse(JSON.parse(line));
      if (message.id !== undefined && accountReads.delete(message.id) && message.result) {
        out({
          ...message,
          result: {
            ...message.result,
            account: { type: 'chatgpt', email: STAND_IN.email, planType: 'pro' },
          },
        });
        return;
      }
      stdout.write(`${line}\n`);
    },
    () => stdout.end(),
  );
  return {
    pid: child.pid,
    stdin,
    stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
    once: (event, listener) => child.once(event, listener),
  };
}

/** A `codex` that runs the real one on the fake model's provider, set by flag, never in a file. */
function codexOnFakeModel(dir: string, codex: string, baseUrl: string): string {
  const path = join(dir, 'codex-on-fake-model');
  const provider = `model_providers.fake={ name = "fake", base_url = "${baseUrl}", wire_api = "responses", requires_openai_auth = false }`;
  writeFileSync(
    path,
    `#!/bin/sh\nexec '${codex}' "$@" -c 'model_provider="fake"' -c '${provider}'\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

// ---------------------------------------------------------------------------------------------

interface GuardCall {
  readonly toolName: string;
  readonly input: string;
}

/** A `codex` the adapter started, and whether it still runs. */
interface StartedCodex {
  readonly child: CodexChild;
  readonly exit: Promise<void>;
  readonly running: () => boolean;
}

/**
 * Ends every `codex` that still runs and waits for each to exit, failing with the pids still running
 * once the deadline passes.
 */
async function endCodexes(started: readonly StartedCodex[]): Promise<void> {
  for (const codex of started) if (codex.running()) codex.child.kill();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((done) => {
    timer = setTimeout(() => {
      done('late');
    }, EXIT_DEADLINE_MS);
  });
  try {
    const all = Promise.all(started.map((codex) => codex.exit)).then(() => 'exited' as const);
    if ((await Promise.race([all, late])) === 'late') {
      const pids = started.filter((codex) => codex.running()).map((codex) => codex.child.pid);
      throw new Error(`codex did not exit in ${String(EXIT_DEADLINE_MS)} ms: ${pids.join(', ')}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

interface World {
  readonly root: string;
  readonly checkout: string;
  /** Another registered checkout, which a lane can neither read nor write. */
  readonly other: string;
  /** The account's Codex home, under a data dir whose path has a space, as the app's does. */
  readonly codexHome: string;
  readonly socketDir: string;
  readonly model: FakeResponses;
  readonly mcp: FakeMcp;
  /** The bearer token of the session's MCP server, which Codex alone holds. */
  readonly mcpToken: string;
  readonly adapter: SessionAdapter;
  readonly laneSandbox: LaneSandbox;
  /** The daemon's roots, made as its start makes them: the lane temp root is the shared one. */
  readonly roots: SandboxRoots;
  readonly account: AccountRow;
  /** Every call the guard was asked about, in order. */
  readonly calls: GuardCall[];
  /** Every line the daemon's logger wrote. */
  readonly logs: string[];
  /** Run on each guard call before it is judged, for a test that acts mid-session. */
  onCall: (call: GuardCall, spec: SessionSpec) => void;
  close(): Promise<void>;
}

interface SessionRun {
  readonly events: readonly SessionEvent[];
  readonly threadId: string | null;
  readonly request: FakeRequest | undefined;
  readonly spec: SessionSpec;
}

let codexPath: string;
let launcher: Launcher;

/** The login shell's PATH, which holds the node the `codex` script runs on. */
function launchPath(): string {
  return launcher.projectEnv()['PATH'] ?? '/usr/bin:/bin';
}

async function openWorld(): Promise<World> {
  mkdirSync(LIVE_PARENT, { recursive: true, mode: 0o700 });
  const root = realpathSync(mkdtempSync(join(LIVE_PARENT, LIVE_PREFIX)));
  // What is open so far, closed again when a later step fails.
  const opened: (() => Promise<void>)[] = [];
  try {
    return await openWorldIn(root, opened);
  } catch (error) {
    await closeAll(opened).catch(() => undefined);
    removeLiveDir(root);
    throw error;
  }
}

/** Closes what was opened, last first, every one even when one fails; the first failure is thrown. */
async function closeAll(opened: readonly (() => Promise<void>)[]): Promise<void> {
  const failures: Error[] = [];
  for (const close of [...opened].reverse())
    await close().catch((error: unknown) => {
      failures.push(
        error instanceof Error ? error : new Error('a live test resource would not close'),
      );
    });
  const [first] = failures;
  if (first !== undefined) throw first;
}

async function openWorldIn(root: string, opened: (() => Promise<void>)[]): Promise<World> {
  const dataDir = join(root, 'Application Support', '10db');
  const accountId: AccountId = mintId('Account');
  const codexHome = join(dataDir, 'accounts', accountId, 'codex');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const checkout = join(root, 'checkout');
  const other = join(root, 'other');
  initRepo(checkout);
  initRepo(other);
  const socketDir = join(root, 'run');
  const model = await startFakeResponses();
  opened.push(() => model.close());
  const token = randomUUID();
  const mcp = await startFakeMcp(token);
  opened.push(() => mcp.close());
  const logs: string[] = [];
  const logger = createLogger({
    level: 'info',
    destination: {
      write: (line: string) => {
        logs.push(line);
      },
    },
  });
  const wrapper = codexOnFakeModel(root, codexPath, model.baseUrl);
  const started: StartedCodex[] = [];
  // Codex writes its state in the home until it exits, so the directory goes after it.
  opened.push(() => endCodexes(started));
  const adapter = createCodexAdapter({
    codexPath: wrapper,
    logger,
    socketDir,
    spawn: (path, env) => {
      const child = spawnAppServer(path, env);
      let running = true;
      const exit = new Promise<void>((done) => {
        child.once('exit', () => {
          running = false;
          done();
        });
      });
      started.push({ child, exit, running: () => running });
      return withStandInAccount(child);
    },
  });
  const roots = openSandboxRoots({}, homedir());
  if (roots.refusal !== null) throw roots.refusal;
  // Marked as a running daemon's, so a test daemon that starts meanwhile leaves the lanes' files alone.
  const claim = claimSandboxRoots([roots.temp, roots.codexLanes, roots.files]);
  opened.push(() => {
    claim.release();
    return Promise.resolve();
  });
  const laneSandbox = createLaneSandbox({
    home: homedir(),
    dataDir,
    loginConfigDir: null,
    ...sandboxDepsOf(roots),
    gitDirs: (repo) => createGit().gitDirs(repo),
    runtime: resolveSandboxRuntime(),
    worktreeRoot: join(root, 'worktrees'),
  });
  const account: AccountRow = {
    id: accountId,
    kind: 'codex_signin',
    label: 'ChatGPT plan',
    payer: '',
    expectedIdentity: `${STAND_IN.email} · ${STAND_IN.workspace}`,
    configDir: codexHome,
    secretRef: null,
    secretFingerprint: null,
    settings: {},
    laneCap: 4,
    monthlyCapUsd: null,
    archived: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const world: World = {
    root,
    checkout,
    other,
    codexHome,
    socketDir,
    model,
    mcp,
    mcpToken: token,
    adapter,
    laneSandbox,
    roots,
    account,
    calls: [],
    logs,
    onCall: () => undefined,
    close: async () => {
      try {
        await closeAll(opened);
      } finally {
        removeLiveDir(root);
      }
    },
  };
  return world;
}

/**
 * What the runner hands the lane sandbox for a session on the world's account: a ChatGPT lane's,
 * whose temp dir is in the Codex lanes root, unless `claude` asks for a Claude lane's.
 */
function laneInput(
  world: World,
  env: Readonly<Record<string, string>>,
  opts: {
    readonly hosts?: readonly string[];
    readonly reads?: readonly string[];
    readonly resume?: string | null;
    readonly claude?: boolean;
    /** The task's pictures folder, as the runner names it for a lane of a task with pictures. */
    readonly taskFiles?: string;
    /** What comes along into the session, as the runner plans it. */
    readonly setup?: SetupInput;
  } = {},
): LaneSessionInput {
  return {
    project: {
      id: mintId('Project'),
      repoPath: world.checkout,
      sandboxLoopback: false,
      gateCommand: 'true',
    },
    env,
    rules: [
      ...(opts.hosts ?? []).map((host) => ({ toolName: 'SandboxNetworkAccess', pattern: host })),
      ...(opts.reads ?? []).map((path) => ({ toolName: 'Read', pattern: path })),
    ],
    resumeProviderSessionId: opts.resume ?? null,
    configDir: world.codexHome,
    checkouts: [world.checkout, world.other],
    mcpServers: {},
    ...(opts.taskFiles === undefined ? {} : { taskFiles: opts.taskFiles }),
    ...(opts.setup === undefined ? {} : { setup: opts.setup }),
    ...(opts.claude === true ? {} : { tempRoot: world.roots.codexLanes, provider: Provider.Codex }),
  };
}

/** Runs one session of `steps` to the end of its first turn, then stops it. */
async function runSession(
  world: World,
  steps: Parameters<FakeResponses['script']>[0],
  opts: {
    readonly hosts?: readonly string[];
    readonly reads?: readonly string[];
    readonly resume?: string | null;
    readonly sessionId?: SessionId;
    /** A builder message's client uuid and pictures, as a pass page's prompt carries them. */
    readonly promptUuid?: string;
    readonly images?: readonly ShapeImage[];
    readonly taskFiles?: string;
    readonly setup?: SetupInput;
    readonly instructions?: string;
  } = {},
): Promise<SessionRun> {
  const launch = launcher.session(world.account, MODEL, []);
  const laneSession = await world.laneSandbox.forSession(laneInput(world, launch.env, opts));
  try {
    return await runOnLane(world, steps, opts, launch, laneSession);
  } finally {
    laneSession.dispose();
  }
}

async function runOnLane(
  world: World,
  steps: Parameters<FakeResponses['script']>[0],
  opts: {
    readonly resume?: string | null;
    readonly sessionId?: SessionId;
    readonly promptUuid?: string;
    readonly images?: readonly ShapeImage[];
    readonly instructions?: string;
  },
  launch: ReturnType<Launcher['session']>,
  laneSession: Awaited<ReturnType<LaneSandbox['forSession']>>,
): Promise<SessionRun> {
  const prompt = world.model.script(steps);
  const spec: SessionSpec = {
    sessionId: opts.sessionId ?? mintId('Session'),
    workstreamId: mintId('Workstream'),
    sequence: 1,
    cwd: world.checkout,
    prompt,
    ...(opts.promptUuid === undefined ? {} : { promptUuid: opts.promptUuid }),
    ...(opts.images === undefined ? {} : { images: opts.images }),
    model: launch.model,
    effort: 'low',
    resumeProviderSessionId: opts.resume ?? null,
    env: launch.env,
    account: launch.expect,
    projectMcpServers: {},
    allowedTools: [],
    sandbox: laneSession.spec,
    ...(opts.instructions === undefined ? {} : { instructions: opts.instructions }),
    setup: { plugins: laneSession.setup.pluginDirs, skillRoots: laneSession.setup.skillRoots },
    mcp: { url: world.mcp.url, token: world.mcpToken, toolTimeoutMs: 60_000 },
    preToolUse: (req) => {
      const call = { toolName: req.toolName, input: JSON.stringify(req.input) };
      world.calls.push(call);
      world.onCall(call, spec);
      return call.input.includes(DENIED)
        ? { decision: 'deny', reason: DENIAL_REASON }
        : { decision: 'allow' };
    },
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'Nothing asks in this test.' }),
  };
  const handle = world.adapter.start(spec);
  const events: SessionEvent[] = [];
  try {
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'turn_complete') await handle.stop();
    }
  } finally {
    await handle.stop();
  }
  const started = events.find((e) => e.type === 'started');
  return {
    events,
    threadId: started?.type === 'started' ? started.providerSessionId : null,
    request: world.model.lastRequest(prompt),
    spec,
  };
}

/** The session started and its turn completed: every start check passed and the prompt ran. */
function expectTurn(run: SessionRun): readonly string[] {
  // A refused start shows its message here.
  expect(run.events.find((e) => e.type === 'ended')).toMatchObject({
    reason: 'stopped',
    message: null,
  });
  expect(run.events.map((e) => e.type)).toContain('started');
  const turn = run.events.find((e) => e.type === 'turn_complete');
  expect(turn).toBeDefined();
  expect(turn).not.toHaveProperty('result');
  expect(run.request).toBeDefined();
  return run.request?.outputs ?? [];
}

describe.skipIf(!live)(
  'Codex on the real codex and a fake model, live',
  { timeout: 120_000 },
  () => {
    let world: World;
    /** Whether `world` is open: a `beforeEach` that failed left none to close. */
    let open = false;

    beforeAll(async () => {
      // The pinned release, as the daemon runs it: this test is what verifies a bump of that pin.
      codexPath = await ensureAgent(AgentTool.Codex);
      const login = await captureLoginEnv({ inherited: process.env });
      launcher = createLauncher({
        base: login.vars,
        clientApp: '10db/live-test',
        keychain: createMemoryKeychain(),
      });
    });
    beforeEach(async () => {
      world = await openWorld();
      open = true;
    });
    afterEach(async () => {
      if (!open) return;
      open = false;
      await world.close();
      // No log line names the account's email or carries the session's MCP token.
      expect(
        world.logs.filter((line) => line.includes(STAND_IN.email) || line.includes(world.mcpToken)),
      ).toEqual([]);
    });

    it('ignores a planted .codex/ on a first session, a second session and a resume', async () => {
      const plantedMcp = join(world.root, 'planted-mcp-ran');
      const plantedHook = join(world.root, 'planted-hook-ran');
      mkdirSync(join(world.checkout, '.codex'));
      writeFileSync(
        join(world.checkout, '.codex', 'config.toml'),
        [
          'model = "planted-model"',
          'default_permissions = "planted"',
          '[permissions.planted.filesystem]',
          '":root" = "read"',
          '[permissions.planted.network]',
          'enabled = true',
          'mode = "full"',
          '[mcp_servers.planted]',
          'command = "/usr/bin/touch"',
          `args = [${JSON.stringify(plantedMcp)}]`,
          '[[hooks.PreToolUse]]',
          '[[hooks.PreToolUse.hooks]]',
          'type = "command"',
          `command = ${JSON.stringify(`/usr/bin/touch '${plantedHook}'`)}`,
          '',
        ].join('\n'),
      );

      const first = await runSession(world, [run('echo one > first.txt'), { say: 'done' }]);
      expectTurn(first);
      const second = await runSession(world, [run('echo two > second.txt'), { say: 'done' }]);
      expectTurn(second);
      const resumed = await runSession(world, [run('echo three > third.txt'), { say: 'done' }], {
        resume: first.threadId,
      });
      expectTurn(resumed);
      expect(resumed.threadId).toBe(first.threadId);

      for (const file of ['first.txt', 'second.txt', 'third.txt'])
        expect(existsSync(join(world.checkout, file))).toBe(true);
      expect(existsSync(plantedMcp)).toBe(false);
      expect(existsSync(plantedHook)).toBe(false);
      // The checkout is still pinned untrusted in the account's home, after all three.
      expect(parse(readFileSync(join(world.codexHome, 'config.toml'), 'utf8'))).toMatchObject({
        projects: { [world.checkout]: { trust_level: 'untrusted' } },
      });
    });

    it('runs the hook, from a home path with a space', async () => {
      expect(world.codexHome).toContain(' ');
      const outputs = expectTurn(
        await runSession(world, [
          run('echo hooked > hooked.txt'),
          run("env | cut -d= -f1 | sort | tr '\\n' ' '"),
          { say: 'done' },
        ]),
      );
      expect(world.calls[0]).toMatchObject({ toolName: 'Bash' });
      expect(world.calls[0]?.input).toContain('echo hooked > hooked.txt');
      expect(readFileSync(join(world.checkout, 'hooked.txt'), 'utf8')).toBe('hooked\n');
      // A command's environment holds no 10db variable but the sandbox's mark: not the session's
      // token, nor the guard's socket.
      expect(outputs[1]).toContain('PATH');
      expect(outputs[1]).toContain('TENDB_SANDBOX');
      expect(outputs[1]).not.toMatch(/TENDB_(?!SANDBOX\b)/);
    });

    it('refuses a call the guard denies, for Bash, apply_patch and an MCP tool', async () => {
      const outputs = expectTurn(
        await runSession(world, [
          run(`echo ${DENIED} > bash-denied.txt`),
          patch(addFile(`${DENIED}-patch.txt`, 'denied')),
          commit(DENIED),
          run('echo allowed > bash-allowed.txt'),
          patch(addFile('patch-allowed.txt', 'allowed')),
          commit('allowed'),
          { say: 'done' },
        ]),
      );
      expect(world.calls.map((c) => c.toolName)).toEqual([
        'Bash',
        'Edit',
        'mcp__10db__commit',
        'Bash',
        'Edit',
        'mcp__10db__commit',
      ]);
      // Each refusal reached the model with the guard's reason, and nothing it asked for happened.
      for (const output of outputs.slice(0, 3)) expect(output).toContain(DENIAL_REASON);
      expect(existsSync(join(world.checkout, 'bash-denied.txt'))).toBe(false);
      expect(existsSync(join(world.checkout, `${DENIED}-patch.txt`))).toBe(false);
      expect(world.mcp.calls).toEqual([JSON.stringify({ message: 'allowed' })]);
      expect(readFileSync(join(world.checkout, 'bash-allowed.txt'), 'utf8')).toBe('allowed\n');
      expect(readFileSync(join(world.checkout, 'patch-allowed.txt'), 'utf8')).toBe('allowed\n');
    });

    it('refuses the call when the guard socket is gone', async () => {
      world.onCall = (call, spec) => {
        if (call.input.includes('SOCKET-GOES-NOW'))
          unlinkSync(guardSocketPath(world.socketDir, spec.sessionId));
      };
      const outputs = expectTurn(
        await runSession(world, [
          run('echo SOCKET-GOES-NOW'),
          run('echo after > after-socket.txt'),
          { say: 'done' },
        ]),
      );
      expect(outputs[0]).toContain('SOCKET-GOES-NOW');
      expect(world.calls).toHaveLength(1);
      expect(outputs[1]).toContain('10db could not check this call, so it was refused.');
      expect(existsSync(join(world.checkout, 'after-socket.txt'))).toBe(false);
    });

    it('keeps a lane from reading auth.json, a .env file and another checkout', async () => {
      const auth = join(world.codexHome, 'auth.json');
      const secrets = {
        auth: plant(auth),
        env: plant(join(world.checkout, '.env')),
        other: plant(join(world.other, 'notes.txt')),
      };
      const outputs = expectTurn(
        await runSession(world, [
          run(`cat '${auth}'; echo auth=$?`),
          run('cat .env; echo env=$?'),
          run(`cat '${join(world.other, 'notes.txt')}'; echo other=$?`),
          { say: 'done' },
        ]),
      );
      const said = outputs.join('\n');
      for (const token of Object.values(secrets)) expect(said).not.toContain(token);
      expect(outputs[0]).toMatch(/auth=1/);
      expect(outputs[1]).toMatch(/env=1/);
      expect(outputs[2]).toMatch(/other=1/);
      // The sandbox refused each read; the file was there to read all along.
      for (const output of outputs.slice(0, 3)) expect(output).toContain('Operation not permitted');
      expect(readFileSync(auth, 'utf8')).toBe(`${secrets.auth}\n`);
    });

    it("keeps a lane from reading auth.json when the project's read list opens the test's root", async () => {
      // The read list opens every ancestor of the data dir here: only 10db's denies of the data dir
      // and the account's home, which lie under it, keep the file closed.
      const auth = join(world.codexHome, 'auth.json');
      const token = plant(auth);
      const notes = plant(join(world.root, 'notes.txt'));
      const outputs = expectTurn(
        await runSession(
          world,
          [
            run(`cat '${join(world.root, 'notes.txt')}'; echo notes=$?`),
            run(`cat '${auth}'; echo auth=$?`),
            { say: 'done' },
          ],
          { reads: [world.root] },
        ),
      );
      // The grant took: a file beside the data dir is read.
      expect(outputs[0]).toContain(notes);
      expect(outputs[0]).toMatch(/notes=0/);
      expect(outputs.join('\n')).not.toContain(token);
      expect(outputs[1]).toMatch(/auth=1/);
      expect(outputs[1]).toContain('Operation not permitted');
      expect(readFileSync(auth, 'utf8')).toBe(`${token}\n`);
    });

    it("keeps a lane out of other lanes' temp dirs, in either lanes' root, and out of 10db's files", async () => {
      // Another Claude lane's session and another ChatGPT lane's, made as the daemon makes them.
      const { env } = launcher.session(world.account, MODEL, []);
      const ledgersBefore = (): string[] =>
        readdirSync(world.roots.files).filter((name) => name.startsWith('10db-proc-'));
      const known = new Set(ledgersBefore());
      const claudeLane = await world.laneSandbox.forSession(
        laneInput(world, env, { claude: true }),
      );
      let codexLane: Awaited<ReturnType<LaneSandbox['forSession']>> | null = null;
      try {
        codexLane = await world.laneSandbox.forSession(laneInput(world, env));
        expect(dirname(claudeLane.tmpDir)).toBe(world.roots.temp);
        expect(dirname(codexLane.tmpDir)).toBe(world.roots.codexLanes);
        const secrets = {
          claude: plant(join(claudeLane.tmpDir, 'notes.txt')),
          codex: plant(join(codexLane.tmpDir, 'notes.txt')),
        };
        const envFile = claudeLane.spec.env['CLAUDE_ENV_FILE'] ?? '';
        expect(dirname(envFile)).toBe(world.roots.files);
        const [ledgerName] = ledgersBefore().filter((name) => !known.has(name));
        if (ledgerName === undefined) throw new Error('the other lanes kept no ledger');
        const ledger = join(world.roots.files, ledgerName);
        const ledgerBefore = readFileSync(ledger, 'utf8');
        const planted = join(world.roots.files, '10db-planted');
        const outputs = expectTurn(
          await runSession(world, [
            run(`cat '${join(claudeLane.tmpDir, 'notes.txt')}'; echo claudeRead=$?`),
            run(`echo x > '${join(claudeLane.tmpDir, 'planted')}'; echo claudeWrite=$?`),
            run(`cat '${join(codexLane.tmpDir, 'notes.txt')}'; echo codexRead=$?`),
            run(`echo x > '${join(codexLane.tmpDir, 'planted')}'; echo codexWrite=$?`),
            run(`cat '${envFile}'; echo envRead=$?`),
            run(`echo '{}' > '${ledger}'; echo ledgerWrite=$?`),
            run(`echo x > '${planted}'; echo filesWrite=$?`),
            // The control: its own temp dir, in the same root, it writes and reads.
            run(
              `echo "TMPDIR=$TMPDIR"; printf '%s-%s' own written > "$TMPDIR/own.txt" && cat "$TMPDIR/own.txt"`,
            ),
            { say: 'done' },
          ]),
        );
        const said = outputs.join('\n');
        for (const token of Object.values(secrets)) expect(said).not.toContain(token);
        expect(said).not.toContain('export TENDB_SANDBOX=');
        const probes = [
          'claudeRead',
          'claudeWrite',
          'codexRead',
          'codexWrite',
          'envRead',
          'ledgerWrite',
          'filesWrite',
        ];
        // `cat` says "Operation not permitted"; the lane's zsh, refused a redirection, lowercases it.
        probes.forEach((name, at) => {
          expect(outputs[at], name).toMatch(new RegExp(`${name}=1`));
          expect(outputs[at], name).toMatch(/operation not permitted/i);
        });
        for (const dir of [claudeLane.tmpDir, codexLane.tmpDir])
          expect(existsSync(join(dir, 'planted'))).toBe(false);
        expect(existsSync(planted)).toBe(false);
        expect(readFileSync(ledger, 'utf8')).toBe(ledgerBefore);
        // The session's own temp dir, named by six characters in the Codex lanes root.
        const lanesRoot = world.roots.codexLanes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(outputs[7]).toMatch(new RegExp(`TMPDIR=${lanesRoot}/[A-Za-z0-9]{6}(?![A-Za-z0-9])`));
        expect(outputs[7]).toContain('own-written');
      } finally {
        claudeLane.dispose();
        codexLane?.dispose();
      }
    });

    it('keeps a lane from writing .git', async () => {
      const config = join(world.checkout, '.git', 'config');
      const before = readFileSync(config, 'utf8');
      const outputs = expectTurn(
        await runSession(world, [
          run("printf '[alias]\\n  x = !touch pwned\\n' >> .git/config; echo config=$?"),
          run('touch .git/hooks/pre-commit; echo hook=$?'),
          { say: 'done' },
        ]),
      );
      expect(outputs[0]).toMatch(/config=1/);
      expect(outputs[1]).toMatch(/hook=1/);
      expect(readFileSync(config, 'utf8')).toBe(before);
      expect(existsSync(join(world.checkout, '.git', 'hooks', 'pre-commit'))).toBe(false);
    });

    it('keeps a lane from reaching the guard socket', async () => {
      const sessionId = mintId('Session');
      // The session's own socket, which the test knows and the lane is never told.
      const socket = guardSocketPath(world.socketDir, sessionId);
      let socketThere = false;
      world.onCall = (call) => {
        if (call.input.includes('--unix-socket')) socketThere = statSync(socket).isSocket();
      };
      const probe = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'SOCKET-PROBE' } });
      const outputs = expectTurn(
        await runSession(
          world,
          [
            run(
              `/usr/bin/curl --silent --max-time 10 --unix-socket '${socket}' --data-binary '${probe}' http://10db/pre-tool-use; echo curl=$?`,
            ),
            { say: 'done' },
          ],
          { sessionId },
        ),
      );
      expect(socketThere).toBe(true);
      expect(outputs[0]).toMatch(/curl=[1-9]/);
      // Only the curl itself was judged: the call it posted never reached the guard.
      expect(world.calls).toHaveLength(1);
      expect(world.calls[0]?.input).toContain('--unix-socket');
    });

    it('blocks an unlisted host and lets a POST reach a listed one', async () => {
      const outputs = expectTurn(
        await runSession(
          world,
          [
            // Plain http, where the proxy sees the method: `mode = "limited"` would refuse the POST.
            run(curl('listed', 'http://example.com/', { post: true })),
            run(curl('unlisted', 'https://example.org/')),
            { say: 'done' },
          ],
          { hosts: ['example.com'] },
        ),
      );
      // The POST reached the host, which answered it with its page.
      expect(outputs[0]).toContain(EXAMPLE_PAGE);
      expect(outputs[0]).toMatch(/listed=\d{3}/);
      // A blocked host ends the whole command, its output lost, and Codex says why.
      expect(outputs[1]).not.toContain(EXAMPLE_PAGE);
      expect(outputs[1]).toContain(blocked('example.org'));
    });

    it('lets a wildcard host reach the hosts under it, not the domain itself, and blocks another', async () => {
      const outputs = expectTurn(
        await runSession(
          world,
          [
            run(curl('under', 'https://www.example.net/')),
            run(curl('apex', 'https://example.net/')),
            run(curl('another', 'https://www.example.org/')),
            { say: 'done' },
          ],
          { hosts: ['*.example.net'] },
        ),
      );
      expect(outputs[0]).toContain(EXAMPLE_PAGE);
      expect(outputs[0]).toMatch(/under=\d{3}/);
      // Codex matches `*.` against the hosts under the domain only, as Claude Code's sandbox does.
      expect(outputs[1]).toContain(blocked('example.net'));
      expect(outputs[2]).toContain(blocked('www.example.org'));
      for (const output of outputs.slice(1, 3)) expect(output).not.toContain(EXAMPLE_PAGE);
    });

    it('blocks every host for a project that lists none', async () => {
      const outputs = expectTurn(
        await runSession(world, [run(curl('reached', 'https://example.com/')), { say: 'done' }]),
      );
      expect(outputs[0]).toContain(blocked('example.com'));
      expect(outputs[0]).not.toContain(EXAMPLE_PAGE);
    });

    it('offers the model only the tools a lane uses', async () => {
      const run = await runSession(world, [{ say: 'done' }]);
      expectTurn(run);
      const tools = [...(run.request?.tools ?? []), ...(run.request?.execTools ?? [])];
      // On by default in Codex, and off in the home: none is any lane's.
      for (const off of ['image_generation', 'browser', 'computer', 'skill', 'web_search'])
        expect(
          tools.filter((tool) => tool.includes(off)),
          off,
        ).toEqual([]);
      // A tool a later Codex adds shows here before it reaches a lane.
      expect(run.request?.tools).toEqual(OFFERED_TOOLS);
      expect(run.request?.execTools).toEqual(EXEC_TOOLS);
    });

    it('runs with the real toolchain: node and git status', async () => {
      writeFileSync(join(world.checkout, 'untracked.txt'), 'new\n');
      const outputs = expectTurn(
        await runSession(world, [
          run('node -v; echo node=$?; git status --short; echo git=$?'),
          { say: 'done' },
        ]),
      );
      expect(outputs[0]).toMatch(/v\d+\.\d+\.\d+/);
      expect(outputs[0]).toContain('node=0');
      expect(outputs[0]).toContain('?? untracked.txt');
      expect(outputs[0]).toContain('git=0');
    });

    /**
     * Builder skill folders `~/<temp>/<name>`, two levels into the home (a skill directly in it, or
     * in ~/.10db where the world lives, is refused), each with a SKILL.md naming it.
     */
    const builderSkills = (names: readonly string[]): { input: SetupInput; dir: string } => {
      const dir = realpathSync(mkdtempSync(join(homedir(), '10db-live-skills-')));
      const skills = names.map((name) => {
        const path = join(dir, name);
        mkdirSync(path);
        writeFileSync(
          join(path, 'SKILL.md'),
          `---\nname: ${name}\ndescription: The ${name} skill, for the live check.\n---\n\n${name} body\n`,
        );
        return { name, path, skillFile: join(path, 'SKILL.md') };
      });
      return { input: { skills, plugins: [], projectFiles: [] }, dir };
    };

    it('lists a builder skill linked into yours/skills and reads its SKILL.md, and still cannot read auth.json', async () => {
      const { input, dir } = builderSkills(['tendb-live-skill']);
      try {
        const auth = join(world.codexHome, 'auth.json');
        const token = plant(auth);
        const session = await runSession(
          world,
          [
            run(`cat '${join(dir, 'tendb-live-skill', 'SKILL.md')}'; echo skill=$?`),
            run(`cat '${auth}'; echo auth=$?`),
            { say: 'done' },
          ],
          { setup: input, instructions: 'LIVE-INSTRUCTIONS-MARK: use pnpm.' },
        );
        const outputs = expectTurn(session);
        expect(outputs[0]).toContain('tendb-live-skill body');
        expect(outputs[0]).toContain('skill=0');
        expect(outputs[1]).toMatch(/auth=1/);
        expect(outputs.join('\n')).not.toContain(token);
        // Codex listed the skill through the root of links, and the instructions reached the model.
        const developer = (session.request?.developerTexts ?? []).join('\n');
        expect(developer).toContain('tendb-live-skill');
        expect(developer).toContain('LIVE-INSTRUCTIONS-MARK');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('runs node and git with about 200 skills in the setup', async () => {
      const { input, dir } = builderSkills(
        Array.from({ length: 200 }, (_, i) => `tendb-live-${String(i).padStart(3, '0')}`),
      );
      try {
        writeFileSync(join(world.checkout, 'untracked.txt'), 'new\n');
        const outputs = expectTurn(
          await runSession(
            world,
            [run('node -v; echo node=$?; git status --short; echo git=$?'), { say: 'done' }],
            { setup: input },
          ),
        );
        expect(outputs[0]).toMatch(/v\d+\.\d+\.\d+/);
        expect(outputs[0]).toContain('node=0');
        expect(outputs[0]).toContain('?? untracked.txt');
        expect(outputs[0]).toContain('git=0');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('takes a builder message with a picture under its client uuid, and reads the thread back once it closed', async () => {
      const picturePath = join(world.root, 'header.png');
      const png = noisePng(4, 4);
      writeFileSync(picturePath, png);
      const picture: ShapeImage = {
        mediaType: 'image/png',
        data: png.toString('base64'),
        path: picturePath,
      };
      const first = randomUUID();
      const page = await runSession(world, [{ say: 'Looked at the header.' }], {
        promptUuid: first,
        images: [picture],
      });
      expectTurn(page);
      // The turn took the message on evidence, before it completed, and the model got the picture.
      const kinds = page.events.map((e) => e.type);
      expect(page.events).toContainEqual({ type: 'consumed', uuids: [first] });
      expect(kinds.indexOf('consumed')).toBeLessThan(kinds.indexOf('turn_complete'));
      expect(page.request?.images).toBe(1);

      // The next message resumes the closed session; the thread read back holds both, and nothing else.
      const second = randomUUID();
      const resumed = await runSession(world, [{ say: 'Made it smaller.' }], {
        resume: page.threadId,
        promptUuid: second,
        images: [picture],
      });
      expectTurn(resumed);
      expect(resumed.threadId).toBe(page.threadId);
      // The picture goes again with the message sent again: the thread holds both sends.
      expect(resumed.request?.images).toBe(2);
      expect(resumed.events).toContainEqual({ type: 'consumed', uuids: [second] });
      const launch = launcher.session(world.account, MODEL, []);
      const held = await world.adapter.readClientUuids({
        account: launch.expect,
        env: launch.env,
        cwd: world.checkout,
        providerSessionId: page.threadId ?? '',
        wanted: [first, second, randomUUID()],
        since: new Date(0).toISOString(),
      });
      expect([...held].sort()).toEqual([first, second].sort());
    });

    it("cannot open its task's stored picture by its path: the guard refuses view_image, the sandbox the shell", async () => {
      const files = join(world.root, 'Application Support', '10db', 'tasks', 'tsk_live', 'files');
      mkdirSync(files, { recursive: true });
      const shot = join(files, 'shot.png');
      writeFileSync(shot, noisePng(4, 4));
      const outputs = expectTurn(
        await runSession(
          world,
          [
            codeMode(`tools.view_image({ path: ${JSON.stringify(shot)} })`),
            run(`wc -c < '${shot}'; echo exit=$?`),
          ],
          { taskFiles: files },
        ),
      );
      // So 10db sends Codex every picture as a local image, on every push.
      expect(outputs[0]).toContain('does not allow the tool "view_image" in a lane');
      expect(outputs[1]).toContain('operation not permitted');
      expect(outputs[1]).toContain('exit=1');
    });

    it('resumes a thread after the process restarts', async () => {
      const first = await runSession(world, [{ say: 'first' }]);
      expectTurn(first);
      const firstPrompt = first.spec.prompt;
      const resumed = await runSession(world, [{ say: 'second' }], { resume: first.threadId });
      expectTurn(resumed);
      expect(resumed.threadId).toBe(first.threadId);
      // The second process's request carries the first session's conversation.
      expect(resumed.request?.userTexts.some((t) => t.includes(firstPrompt))).toBe(true);
    });

    it.each([
      [
        'an indented header after an Add hunk',
        ['*** Add File: a.txt', '+a', '  *** Add File: b.txt', '+b'],
        {},
      ],
      ['two spaces after the colon', ['*** Add File:  spaced.txt', '+s'], {}],
      [
        'a context line starting with ***',
        // A context line that reads as a header, which Codex leaves as context.
        ['*** Update File: notes.md', '@@', ' *** Add File: sneaky.txt', '-old', '+new'],
        { 'notes.md': '*** Add File: sneaky.txt\nold\n' },
      ],
      [
        'a Move',
        ['*** Update File: from.txt', '*** Move to: to.txt', '@@', '-x', '+y'],
        { 'from.txt': 'x\n' },
      ],
      ['a Delete', ['*** Delete File: gone.txt'], { 'gone.txt': 'bye\n' }],
    ] as const)("writes the paths 10db's patch reader names: %s", (_name, lines, files) => {
      const dir = join(world.root, 'patch');
      mkdirSync(dir);
      for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
      const snapshot = (): Map<string, string> =>
        new Map(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), 'utf8')]));
      const before = snapshot();
      const body = ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n');
      // No login and no model turn: Codex's own patch tool, run in a scratch directory.
      execFileSync(codexPath, ['--codex-run-as-apply-patch', body], {
        cwd: dir,
        env: { PATH: launchPath(), HOME: dir, CODEX_HOME: world.codexHome },
        stdio: 'pipe',
      });
      const after = snapshot();
      const written = [...new Set([...before.keys(), ...after.keys()])].filter(
        (file) => before.get(file) !== after.get(file),
      );
      // A patch Codex refused writes nothing, which would match a reader that names nothing.
      expect(written.length).toBeGreaterThan(0);
      expect(new Set(written)).toEqual(new Set(patchPaths(body)));
    });
  },
);
