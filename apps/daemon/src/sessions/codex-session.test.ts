import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountKind, AccountProblem, mintId } from '@10db/contracts';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_SRT, SANDBOXED } from '../../test/fixtures';
import { sandboxedMcpServer } from '../../test/sandboxed-mcp';
import { ManualClock } from '../clock';
import { silentLogger, type Logger } from '../log';
import { autoModeRules, type LaneSandboxSpec } from '../sandbox';
import { codexThreadConfig } from './codex-lane-config';
import { codexHomes, type CodexHome } from './codex-home';
import { guardSocketPath, startCodexSession, type CodexSessionDeps } from './codex-session';
import { fakeAppServer, type FakeAppServer } from './codex-test-support';
import type { SignInState } from './sign-in-check';
import type { SessionEvent, SessionHandle, SessionSpec } from './types';

const FINE = {
  initialize: { userAgent: 'codex/0.154.0', codexHome: '/h/codex' },
  'account/read': {
    account: { type: 'chatgpt', email: 'me@example.com', planType: 'pro' },
    requiresOpenaiAuth: true,
  },
  'account/rateLimits/read': {
    rateLimits: { limitId: 'codex', primary: { usedPercent: 12 } },
    accountId: 'ws-1',
  },
  'config/read': {
    layers: [
      { name: { type: 'user' }, disabledReason: null },
      { name: { type: 'project' }, disabledReason: 'the project is not trusted' },
    ],
  },
  'hooks/list': hooksOf({ trustStatus: 'trusted', enabled: true }),
  'thread/start': threadOf('gpt-5.6-sol', 'lane'),
  'thread/resume': threadOf('gpt-5.6-sol', 'lane'),
  'turn/start': { turn: { id: 'turn-1', status: 'inProgress' } },
};

function hooksOf(hook: { trustStatus: string; enabled: boolean; eventName?: string }) {
  return {
    data: [
      {
        cwd: '/c',
        hooks: [
          {
            key: '/codex/config.toml:pre_tool_use:0:0',
            eventName: hook.eventName ?? 'preToolUse',
            enabled: hook.enabled,
            currentHash: 'sha256:abc',
            trustStatus: hook.trustStatus,
          },
        ],
      },
    ],
  };
}

function threadOf(model: string, profile: string) {
  return { thread: { id: 'thr-1' }, model, activePermissionProfile: { id: profile } };
}

const sandbox: LaneSandboxSpec = {
  settings: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    allowAppleEvents: false,
    autoAllowBashIfSandboxed: false,
    filesystem: { denyRead: ['/'], allowRead: [], allowWrite: [], denyWrite: [] },
    network: { allowedDomains: [], allowMachLookup: [], allowUnixSockets: [] },
    credentials: { envVars: [] },
  },
  env: {},
  disallowedTools: [],
  askRules: [],
  autoMode: autoModeRules('make gate'),
};

let root: string;
let checkout: string;
let codexHome: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-session-'));
  checkout = join(root, 'checkout');
  codexHome = join(root, 'account-home');
  await mkdir(checkout);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function specOf(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: mintId('Session'),
    workstreamId: mintId('Workstream'),
    sequence: 1,
    cwd: checkout,
    prompt: 'Do the task',
    model: 'gpt-5.6-sol',
    effort: 'low',
    resumeProviderSessionId: null,
    env: { PATH: '/opt/homebrew/bin:/usr/bin', CODEX_HOME: codexHome },
    account: {
      accountId: mintId('Account'),
      label: 'ChatGPT plan',
      kind: AccountKind.CodexSignin,
      identity: 'me@example.com · ws-1',
    },
    projectMcpServers: {},
    allowedTools: [],
    sandbox,
    mcp: { url: 'http://127.0.0.1:7777/mcp', token: 'tok-secret-1', toolTimeoutMs: 905_000 },
    preToolUse: () => ({ decision: 'allow' }),
    canUseTool: () => Promise.resolve({ behavior: 'allow' }),
    ...over,
  };
}

function depsOf(server: FakeAppServer, over: Partial<CodexSessionDeps> = {}): CodexSessionDeps {
  return {
    codexPath: '/opt/homebrew/bin/codex',
    logger: silentLogger,
    spawn: server.spawn,
    clock: new ManualClock(),
    socketDir: join(root, 'run'),
    signInCheck: () => Promise.resolve<SignInState>('signed_out'),
    homes: codexHomes(),
    ...over,
  };
}

function startWith(
  script: Record<string, unknown>,
  specOver: Partial<SessionSpec> = {},
  depsOver: Partial<CodexSessionDeps> = {},
): { handle: SessionHandle; server: FakeAppServer; spec: SessionSpec } {
  const server = fakeAppServer({ ...FINE, ...script });
  const spec = specOf(specOver);
  return { handle: startCodexSession(spec, depsOf(server, depsOver)), server, spec };
}

async function collect(handle: SessionHandle): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  for await (const event of handle.events) seen.push(event);
  return seen;
}

async function firstEvent(handle: SessionHandle): Promise<SessionEvent | undefined> {
  for await (const event of handle.events) return event;
  return undefined;
}

const methods = (server: FakeAppServer): (string | undefined)[] =>
  server.sent().map((r) => r.method);

const sentParams = (server: FakeAppServer, method: string): unknown =>
  server.sent().find((r) => r.method === method)?.params;

describe('the start checks', () => {
  const otherEmail = {
    account: { type: 'chatgpt', email: 'someone@example.com', planType: 'pro' },
  };
  const otherWorkspace = { rateLimits: { limitId: 'codex' }, accountId: 'ws-2' };
  const projectLayerOn = {
    layers: [{ name: { type: 'project' }, disabledReason: null }],
  };

  it.each([
    ['the expected account is not reported', { 'account/read': otherEmail }, 'account_refused'],
    [
      'the same email is in another workspace',
      { 'account/rateLimits/read': otherWorkspace },
      'account_refused',
    ],
    ['the account is signed out', { 'account/read': { account: null } }, 'account_refused'],
    [
      'the account read fails',
      { 'account/read': { error: { code: -32000, message: 'me@example.com failed' } } },
      'account_refused',
    ],
    [
      'the usage read fails',
      { 'account/rateLimits/read': { error: { code: -32000, message: 'no usage' } } },
      'account_refused',
    ],
    [
      'the usage read names no workspace',
      { 'account/rateLimits/read': { rateLimits: { limitId: 'codex' } } },
      'account_refused',
    ],
    ['the project layer is enabled', { 'config/read': projectLayerOn }, 'sandbox_refused'],
    ['the hook is missing', { 'hooks/list': { data: [{ hooks: [] }] } }, 'sandbox_refused'],
    [
      'the hook is another event',
      { 'hooks/list': hooksOf({ trustStatus: 'trusted', enabled: true, eventName: 'stop' }) },
      'sandbox_refused',
    ],
    [
      'the hook is disabled',
      { 'hooks/list': hooksOf({ trustStatus: 'trusted', enabled: false }) },
      'sandbox_refused',
    ],
    [
      'the thread runs another profile',
      { 'thread/start': threadOf('gpt-5.6-sol', ':danger-full-access') },
      'sandbox_refused',
    ],
    [
      'the thread names no profile',
      { 'thread/start': { thread: { id: 'thr-1' }, model: 'gpt-5.6-sol' } },
      'sandbox_refused',
    ],
  ])('refuses when %s, with no prompt sent', async (_name, overrides, reason) => {
    const { handle, server } = startWith(overrides);
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason });
    expect(events.filter((e) => e.type === 'started')).toEqual([]);
    expect(methods(server)).not.toContain('turn/start');
    expect(server.killed()).toBe(true);
  });

  it('gives an identity mismatch as the refusal, naming no email', async () => {
    const { handle } = startWith({
      'account/read': {
        account: { type: 'chatgpt', email: 'someone@example.com', planType: 'pro' },
      },
    });
    const ended = (await collect(handle)).at(-1);
    expect(ended).toMatchObject({
      type: 'ended',
      refusal: { problem: AccountProblem.IdentityMismatch },
    });
    expect(JSON.stringify(ended)).not.toContain('me@example.com');
  });

  it('turns an account the app-server cannot read into the sign-in check refusal', async () => {
    const { handle } = startWith({
      'account/read': { error: { code: -32000, message: 'boom' } },
    });
    expect((await collect(handle)).at(-1)).toMatchObject({
      type: 'ended',
      reason: 'account_refused',
      refusal: { problem: AccountProblem.SignedOut },
    });
  });

  it.each<[SignInState, AccountProblem]>([
    ['signed_in', AccountProblem.StartTimeout],
    ['unknown', AccountProblem.StartTimeout],
    ['signed_out', AccountProblem.SignedOut],
  ])('reads %s from codex login status when the account read fails', async (state, problem) => {
    const { handle } = startWith(
      { 'account/read': { error: { code: -32000, message: 'boom' } } },
      {},
      { signInCheck: () => Promise.resolve(state) },
    );
    expect((await collect(handle)).at(-1)).toMatchObject({
      type: 'ended',
      reason: 'account_refused',
      refusal: { problem },
    });
  });

  it('says which check failed when it refuses the sandbox, with nothing the child printed', async () => {
    const { handle } = startWith({ 'config/read': projectLayerOn });
    const ended = (await collect(handle)).at(-1);
    expect(ended).toMatchObject({ type: 'ended', reason: 'sandbox_refused' });
    expect(JSON.stringify(ended)).toMatch(/project/i);
  });

  it('refuses a session with no sandbox, spawning nothing', async () => {
    const spawn = vi.fn();
    const { handle, server } = startWith({}, { sandbox: null }, { spawn });
    expect((await collect(handle)).at(-1)).toMatchObject({
      type: 'ended',
      reason: 'sandbox_refused',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(server.sent()).toEqual([]);
  });

  it('refuses a session with no CODEX_HOME, spawning nothing', async () => {
    const spawn = vi.fn();
    const { handle } = startWith({}, { env: { PATH: '/usr/bin' } }, { spawn });
    expect((await collect(handle)).at(-1)).toMatchObject({
      type: 'ended',
      reason: 'sandbox_refused',
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('the hook trust', () => {
  it('trusts an untrusted hook once, then reads the list again with no restart', async () => {
    let lists = 0;
    const { handle, server } = startWith({
      'hooks/list': () => {
        lists += 1;
        return hooksOf({ trustStatus: lists === 1 ? 'untrusted' : 'trusted', enabled: true });
      },
    });
    expect((await firstEvent(handle))?.type).toBe('started');
    expect(lists).toBe(2);
    expect(methods(server).filter((m) => m === 'hooks/list')).toHaveLength(2);
    const config = parse(await readFile(join(codexHome, 'config.toml'), 'utf8')) as {
      hooks: { state: Record<string, { trusted_hash: string }> };
    };
    expect(config.hooks.state['/codex/config.toml:pre_tool_use:0:0']).toEqual({
      trusted_hash: 'sha256:abc',
    });
  });

  it('refuses if the hook stays untrusted after it was trusted', async () => {
    const { handle, server } = startWith({
      'hooks/list': hooksOf({ trustStatus: 'modified', enabled: true }),
    });
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'sandbox_refused' });
    expect(methods(server).filter((m) => m === 'hooks/list')).toHaveLength(2);
    expect(methods(server)).not.toContain('thread/start');
  });
});

describe('the process', () => {
  it('prepares the home before the process starts', async () => {
    const order: string[] = [];
    const real = codexHomes();
    const homes = (path: string): CodexHome => {
      const home = real(path);
      return {
        path: home.path,
        emptyHome: home.emptyHome,
        prepare: async (dir) => {
          await home.prepare(dir);
          order.push('prepare');
        },
        trustGuardHook: (key, hash) => home.trustGuardHook(key, hash),
      };
    };
    const server = fakeAppServer(FINE);
    const handle = startCodexSession(
      specOf(),
      depsOf(server, {
        homes,
        spawn: () => {
          order.push('spawn');
          return server.child;
        },
      }),
    );
    await firstEvent(handle);
    expect(order).toEqual(['prepare', 'spawn']);
    const config = parse(await readFile(join(codexHome, 'config.toml'), 'utf8')) as {
      projects: Record<string, { trust_level: string }>;
    };
    expect(config.projects[await realpath(checkout)]).toEqual({ trust_level: 'untrusted' });
  });

  it('runs with CODEX_HOME, an empty HOME, TENDB_MCP_TOKEN and the guard variables', async () => {
    let seen: Readonly<Record<string, string>> = {};
    const server = fakeAppServer(FINE);
    const spec = specOf();
    const handle = startCodexSession(
      spec,
      depsOf(server, {
        spawn: (_path, env) => {
          seen = env;
          return server.child;
        },
      }),
    );
    await firstEvent(handle);
    expect(seen).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      CODEX_HOME: codexHome,
      HOME: join(codexHome, 'home'),
      TENDB_MCP_TOKEN: 'tok-secret-1',
      TENDB_GUARD_SOCKET: guardSocketPath(join(root, 'run'), spec.sessionId),
      TENDB_GUARD_MAX_SECONDS: '905',
    });
  });

  it('puts the guard socket in the socket dir under the last 12 characters of the session ID', () => {
    expect(guardSocketPath('/run', mintId('Session'))).toMatch(/^\/run\/[A-Za-z0-9_-]{12}\.sock$/);
    expect(guardSocketPath('/run', 'ses_0123456789abcdefghij')).toBe('/run/89abcdefghij.sock');
  });

  it('warns, with no value from the child, when the version is not the verified one', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (...args: unknown[]) => {
        warnings.push(JSON.stringify(args));
      },
    };
    const { handle } = startWith(
      { initialize: { userAgent: 'codex/9.9.9 (me@example.com)', codexHome: '/h' } },
      {},
      { logger },
    );
    await firstEvent(handle);
    expect(warnings.some((w) => w.includes('9.9.9'))).toBe(true);
    expect(warnings.join()).not.toContain('me@example.com');
  });

  it('puts nothing the child printed in a log line', async () => {
    const lines: string[] = [];
    const record = (...args: unknown[]): void => {
      lines.push(JSON.stringify(args));
    };
    const logger: Logger = {
      debug: record,
      info: record,
      warn: record,
      error: record,
      child: () => logger,
    };
    const server = fakeAppServer({
      ...FINE,
      'account/read': () => new Promise(() => undefined),
    });
    const handle = startCodexSession(specOf(), depsOf(server, { logger }));
    await vi.waitFor(() => {
      expect(methods(server)).toContain('account/read');
    });
    server.writeStderr('signed in as stderr-secret@example.com');
    server.exit(1);
    await collect(handle);
    expect(lines.join('\n')).not.toContain('stderr-secret@example.com');
  });
});

describe('the deadline', () => {
  it('ends the session, closing the child, when a call is not answered in 60 s', async () => {
    const clock = new ManualClock();
    const { handle, server } = startWith(
      { 'hooks/list': () => new Promise(() => undefined) },
      {},
      { clock },
    );
    await vi.waitFor(() => {
      expect(methods(server)).toContain('hooks/list');
    });
    clock.advance(59_999);
    expect(server.killed()).toBe(false);
    clock.advance(1);
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'error' });
    expect(JSON.stringify(events.at(-1))).toContain('hooks/list');
    expect(server.killed()).toBe(true);
    expect(methods(server)).not.toContain('turn/start');
  });

  it('turns an unanswered account read into the sign-in check refusal', async () => {
    const clock = new ManualClock();
    const { handle, server } = startWith(
      { 'account/read': () => new Promise(() => undefined) },
      {},
      { clock, signInCheck: () => Promise.resolve('signed_in') },
    );
    await vi.waitFor(() => {
      expect(methods(server)).toContain('account/read');
    });
    clock.advance(60_000);
    expect((await collect(handle)).at(-1)).toMatchObject({
      type: 'ended',
      reason: 'account_refused',
      refusal: { problem: AccountProblem.StartTimeout },
    });
    expect(server.killed()).toBe(true);
  });
});

describe('the thread and the first turn', () => {
  it('emits started with the thread id and the pid, then turn/start', async () => {
    const { handle, server, spec } = startWith({});
    expect(await firstEvent(handle)).toEqual({
      type: 'started',
      providerSessionId: 'thr-1',
      pid: 4242,
    });
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/start');
    });
    expect(methods(server).slice(-3)).toEqual(['hooks/list', 'thread/start', 'turn/start']);
    expect(methods(server).indexOf('initialized')).toBe(1);
    expect(sentParams(server, 'thread/start')).toEqual({
      cwd: spec.cwd,
      model: 'gpt-5.6-sol',
      approvalPolicy: 'never',
      config: codexThreadConfig(spec),
    });
  });

  it('sends approvalPolicy never, the model, and effort on turn/start', async () => {
    const { handle, server } = startWith({}, { effort: 'high' });
    await firstEvent(handle);
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/start');
    });
    expect(sentParams(server, 'turn/start')).toMatchObject({
      threadId: 'thr-1',
      approvalPolicy: 'never',
      model: 'gpt-5.6-sol',
      effort: 'high',
      input: [{ type: 'text', text: 'Do the task' }],
    });
  });

  it('sends the token nowhere but the child environment', async () => {
    const { handle, server } = startWith({});
    await firstEvent(handle);
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/start');
    });
    expect(JSON.stringify(server.sent())).not.toContain('tok-secret-1');
  });

  it('resumes with thread/resume and the same config', async () => {
    const { handle, server, spec } = startWith({}, { resumeProviderSessionId: 'thr-old' });
    expect(await firstEvent(handle)).toMatchObject({ type: 'started' });
    expect(methods(server)).toContain('thread/resume');
    expect(methods(server)).not.toContain('thread/start');
    expect(sentParams(server, 'thread/resume')).toEqual({
      threadId: 'thr-old',
      cwd: spec.cwd,
      model: 'gpt-5.6-sol',
      approvalPolicy: 'never',
      config: codexThreadConfig(spec),
    });
  });

  it('ends with error when resume fails, naming the thread', async () => {
    const { handle, server } = startWith(
      { 'thread/resume': { error: { code: -32000, message: 'no such thread' } } },
      { resumeProviderSessionId: 'thr-old' },
    );
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'error' });
    expect(JSON.stringify(events.at(-1))).toContain('thr-old');
    expect(methods(server)).not.toContain('turn/start');
    expect(server.killed()).toBe(true);
  });

  it('names the Model map for an alias with no map entry, spawning nothing', async () => {
    const spawn = vi.fn();
    const { handle } = startWith({}, { model: 'sonnet' }, { spawn });
    const events = await collect(handle);
    expect(events).toEqual([
      {
        type: 'ended',
        reason: 'error',
        message: 'Codex refused the model "sonnet". Set this account\'s Model map in Settings.',
      },
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('names the Model map when Codex refuses the model, and pauses nothing', async () => {
    const { handle, server } = startWith({
      'thread/start': { error: { code: -32600, message: 'The model gpt-5.6-sol does not exist' } },
    });
    const ended = (await collect(handle)).at(-1);
    expect(ended).toEqual({
      type: 'ended',
      reason: 'error',
      message: 'Codex refused the model "gpt-5.6-sol". Set this account\'s Model map in Settings.',
    });
    expect(methods(server)).not.toContain('turn/start');
    expect(server.killed()).toBe(true);
  });

  it('names the Model map when the first turn is refused for the model', async () => {
    const { handle, server } = startWith({
      'turn/start': { error: { code: -32600, message: 'unknown model' } },
    });
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({
      type: 'ended',
      reason: 'error',
      message: 'Codex refused the model "gpt-5.6-sol". Set this account\'s Model map in Settings.',
    });
    expect(events.at(-1)).not.toHaveProperty('refusal');
    expect(server.killed()).toBe(true);
  });

  it('fails the session when the thread reports another model', async () => {
    const { handle, server } = startWith({ 'thread/start': threadOf('gpt-6-astra', 'lane') });
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'billing_refused' });
    expect(JSON.stringify(events.at(-1))).toContain('gpt-6-astra');
    expect(methods(server)).not.toContain('turn/start');
    expect(server.killed()).toBe(true);
  });
});

describe('a running session', () => {
  it('ends with one stopped event and closes the child on stop', async () => {
    const { handle, server } = startWith({});
    await firstEvent(handle);
    await handle.stop();
    expect(server.killed()).toBe(true);
    const rest = await collect(handle);
    expect(rest.filter((e) => e.type === 'ended')).toEqual([
      { type: 'ended', reason: 'stopped', message: null },
    ]);
  });

  it('ends with error when the process exits unasked', async () => {
    const { handle, server } = startWith({});
    await firstEvent(handle);
    server.exit(1);
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'error' });
  });
});

describe('codexThreadConfig', () => {
  it('declares the 10db server with its bearer variable, approval mode and tool timeout', () => {
    const config = codexThreadConfig(specOf());
    expect(config).toEqual({
      mcp_servers: {
        '10db': {
          url: 'http://127.0.0.1:7777/mcp',
          bearer_token_env_var: 'TENDB_MCP_TOKEN',
          required: true,
          default_tools_approval_mode: 'approve',
          tool_timeout_sec: 905,
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain('tok-secret-1');
  });

  it('maps a remote repo server to url and http_headers, with the same approval mode', () => {
    const config = codexThreadConfig(
      specOf({
        projectMcpServers: {
          docs: { type: 'http', url: 'https://docs.example/mcp', headers: { 'X-Key': 'k' } },
          plain: { type: 'sse', url: 'https://plain.example/sse', headers: null },
        },
      }),
    );
    expect(config['mcp_servers']).toMatchObject({
      docs: {
        url: 'https://docs.example/mcp',
        http_headers: { 'X-Key': 'k' },
        default_tools_approval_mode: 'approve',
      },
      plain: { url: 'https://plain.example/sse', default_tools_approval_mode: 'approve' },
    });
    expect(config['mcp_servers']).not.toHaveProperty('plain.http_headers');
  });

  // The sandboxed launch is made under a short root in the shared `/tmp`, which no sandbox can write.
  it.skipIf(SANDBOXED)(
    'maps a sandboxed stdio server to its launch, with no env block',
    async () => {
      const made = await sandboxedMcpServer({
        command: 'npx',
        args: ['-y', 'x'],
        env: {},
        hosts: [],
      });
      try {
        const config = codexThreadConfig(specOf({ projectMcpServers: { local: made.server } }));
        const servers = config['mcp_servers'] as Record<string, Record<string, unknown>>;
        expect(servers['local']).toMatchObject({
          command: '/usr/bin/env',
          default_tools_approval_mode: 'approve',
        });
        expect(servers['local']).not.toHaveProperty('env');
        expect(servers['local']?.['args']).toContain(FAKE_SRT.cli);
      } finally {
        made.cleanup();
      }
    },
  );
});
