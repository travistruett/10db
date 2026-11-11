import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { realpathSync } from 'node:fs';
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
import {
  CODEX_HOOK_TIMEOUT_SECONDS,
  CodexHomeError,
  codexHomes,
  type CodexHome,
} from './codex-home';
import {
  guardSocketPath,
  startCodexSession,
  USAGE_READ_RETRY_MS,
  USAGE_READ_TRIES,
  type CodexSessionDeps,
} from './codex-session';
import { fakeAppServer, type FakeAppServer } from './codex-test-support';
import type { SignInState } from './sign-in-check';
import type { SessionEvent, SessionHandle, SessionSpec, ShapeImage } from './types';
import { CODEX_VERIFIED_ON } from '../environment';

const FINE = {
  initialize: { userAgent: `codex/${CODEX_VERIFIED_ON}`, codexHome: '/h/codex' },
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
  'hooks/list': () => hooksOf({ trustStatus: 'trusted', enabled: true }),
  'thread/start': threadOf('gpt-5.6-sol', 'lane'),
  'thread/resume': threadOf('gpt-5.6-sol', 'lane'),
  'turn/start': { turn: { id: 'turn-1', status: 'inProgress' } },
};

interface HookShape {
  trustStatus: string;
  enabled: boolean;
  eventName?: string;
  /** What Codex reports it runs the hook under; 10db's own by default, `null` for none reported. */
  timeoutSec?: number | null;
}

/** A hook another source lists, as a `hooks.json` in the home does; 10db must never trust it. */
const FOREIGN_SOURCE = '/tmp/not-10db/hooks.json';
const OWN_KEY = 'pre_tool_use:0:0';

function entry(hook: HookShape, source: string) {
  return {
    key: `${source}:${OWN_KEY}`,
    eventName: hook.eventName ?? 'preToolUse',
    enabled: hook.enabled,
    currentHash: source === FOREIGN_SOURCE ? 'sha256:evil' : 'sha256:abc',
    trustStatus: hook.trustStatus,
    sourcePath: source,
    source: 'user',
    ...(hook.timeoutSec === null
      ? {}
      : { timeoutSec: hook.timeoutSec ?? CODEX_HOOK_TIMEOUT_SECONDS }),
  };
}

/** The home's own hook, with `foreign` hooks listed before it. */
function hooksOf(hook: HookShape, foreign: HookShape[] = [], own = true) {
  return {
    data: [
      {
        cwd: '/c',
        hooks: [
          ...foreign.map((f) => entry(f, FOREIGN_SOURCE)),
          ...(own ? [entry(hook, join(codexHome, 'config.toml'))] : []),
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
  checkout: '/w/lane',
  env: {},
  shellEnv: { PATH: '/usr/bin', TMPDIR: '/tmp/lane-1' },
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
  codexHome = join(await realpath(root), 'account-home');
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
      'the usage read names no workspace',
      { 'account/rateLimits/read': { rateLimits: { limitId: 'codex' } } },
      'account_refused',
    ],
    ['the project layer is enabled', { 'config/read': projectLayerOn }, 'sandbox_refused'],
    [
      'only a foreign trusted hook is listed',
      {
        'hooks/list': () =>
          hooksOf(
            { trustStatus: 'trusted', enabled: true },
            [{ trustStatus: 'trusted', enabled: true }],
            false,
          ),
      },
      'sandbox_refused',
    ],
    [
      'only a foreign untrusted hook is listed',
      {
        'hooks/list': () =>
          hooksOf(
            { trustStatus: 'trusted', enabled: true },
            [{ trustStatus: 'untrusted', enabled: true }],
            false,
          ),
      },
      'sandbox_refused',
    ],
    ['the config read lists no layers', { 'config/read': {} }, 'sandbox_refused'],
    ['the config read lists null layers', { 'config/read': { layers: null } }, 'sandbox_refused'],
    [
      'initialize fails',
      { initialize: { error: { code: -32000, message: 'no' } } },
      'sandbox_refused',
    ],
    [
      'the config read fails',
      { 'config/read': { error: { code: -32000, message: 'no' } } },
      'sandbox_refused',
    ],
    [
      'the hook list fails',
      { 'hooks/list': { error: { code: -32000, message: 'no' } } },
      'sandbox_refused',
    ],
    [
      'the thread fails for another reason',
      { 'thread/start': { error: { code: -32000, message: 'disk full' } } },
      'sandbox_refused',
    ],
    ['the hook is missing', { 'hooks/list': () => ({ data: [{ hooks: [] }] }) }, 'sandbox_refused'],
    [
      'the hook is another event',
      { 'hooks/list': () => hooksOf({ trustStatus: 'trusted', enabled: true, eventName: 'stop' }) },
      'sandbox_refused',
    ],
    [
      'the hook is disabled',
      { 'hooks/list': () => hooksOf({ trustStatus: 'trusted', enabled: false }) },
      'sandbox_refused',
    ],
    [
      // A hook that times out lets the call run, so a card could not hold it.
      "the hook's timeout is under 10db's",
      {
        'hooks/list': () =>
          hooksOf({
            trustStatus: 'trusted',
            enabled: true,
            timeoutSec: CODEX_HOOK_TIMEOUT_SECONDS - 1,
          }),
      },
      'sandbox_refused',
    ],
    [
      "the hook's timeout is not reported",
      {
        'hooks/list': () => hooksOf({ trustStatus: 'trusted', enabled: true, timeoutSec: null }),
      },
      'sandbox_refused',
    ],
    [
      // An error that says "model" but not the model asked for is no refusal of it.
      'the thread fails naming no requested model',
      { 'thread/start': { error: { code: -32000, message: 'model provider is unavailable' } } },
      'sandbox_refused',
    ],
    [
      // A transient server error that names the model is not the account refusing it.
      'the thread fails with a server error that names the requested model',
      { 'thread/start': { error: { code: -32603, message: 'gpt-5.6-sol is at capacity' } } },
      'sandbox_refused',
    ],
    [
      // The invalid-request code alone is not a refusal: the message must say the model is unknown.
      'the thread is an invalid request that names the model but not a refusal of it',
      {
        'thread/start': {
          error: { code: -32600, message: 'gpt-5.6-sol: context window exceeded' },
        },
      },
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

  // Only a signed-out home waits for its sign-in; any other unread account is a start that failed,
  // which the runner tries again, so it pauses nothing.
  it.each<[SignInState, string, AccountProblem | null]>([
    ['signed_in', 'error', null],
    ['unknown', 'error', null],
    ['signed_out', 'account_refused', AccountProblem.SignedOut],
  ])(
    'reads %s from codex login status when the account read fails',
    async (state, reason, problem) => {
      const { handle } = startWith(
        { 'account/read': { error: { code: -32000, message: 'boom' } } },
        {},
        { signInCheck: () => Promise.resolve(state) },
      );
      const ended = (await collect(handle)).at(-1);
      expect(ended).toMatchObject({ type: 'ended', reason });
      if (problem === null) {
        expect(ended).not.toHaveProperty('refusal');
        expect(JSON.stringify(ended)).toContain('account/read');
      } else expect(ended).toMatchObject({ refusal: { problem } });
    },
  );

  it('refuses a sign-in whose usage read names no workspace, asking once and matching nothing', async () => {
    const { handle, server } = startWith(
      { 'account/rateLimits/read': { rateLimits: { limitId: 'codex' } } },
      {},
      { signInCheck: () => Promise.resolve('signed_in') },
    );
    const ended = (await collect(handle)).at(-1);
    expect(ended).toMatchObject({
      type: 'ended',
      reason: 'account_refused',
      refusal: { problem: AccountProblem.IdentityMismatch, seenIdentity: null },
    });
    expect(JSON.stringify(ended)).toContain('no workspace');
    expect(JSON.stringify(ended)).not.toContain('me@example.com');
    expect(methods(server).filter((m) => m === 'account/rateLimits/read')).toHaveLength(1);
  });

  it("names the hook's timeout when Codex runs the hook under a shorter one", async () => {
    const { handle } = startWith({
      'hooks/list': () => hooksOf({ trustStatus: 'trusted', enabled: true, timeoutSec: 600 }),
    });
    const ended = (await collect(handle)).at(-1);
    expect(ended).toMatchObject({ type: 'ended', reason: 'sandbox_refused' });
    expect(JSON.stringify(ended)).toContain('600 s');
    expect(JSON.stringify(ended)).toContain(`${String(CODEX_HOOK_TIMEOUT_SECONDS)} s`);
  });

  it('starts when Codex runs the hook under a longer timeout than 10db sets', async () => {
    const { handle } = startWith({
      'hooks/list': () =>
        hooksOf({
          trustStatus: 'trusted',
          enabled: true,
          timeoutSec: CODEX_HOOK_TIMEOUT_SECONDS + 1,
        }),
    });
    expect(await firstEvent(handle)).toMatchObject({ type: 'started' });
    await handle.stop();
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
        return hooksOf({ trustStatus: lists === 1 ? 'untrusted' : 'trusted', enabled: true }, [
          { trustStatus: 'untrusted', enabled: true },
        ]);
      },
    });
    expect((await firstEvent(handle))?.type).toBe('started');
    expect(lists).toBe(2);
    expect(methods(server).filter((m) => m === 'hooks/list')).toHaveLength(2);
    const config = parse(await readFile(join(codexHome, 'config.toml'), 'utf8')) as {
      hooks: { state: Record<string, { trusted_hash: string }> };
    };
    // Only the home's own hook is trusted, never the foreign one listed before it.
    expect(config.hooks.state).toEqual({
      [`${join(codexHome, 'config.toml')}:${OWN_KEY}`]: { trusted_hash: 'sha256:abc' },
    });
  });

  it('refuses, trusting nothing, when a foreign hook is the only one listed', async () => {
    const { handle } = startWith({
      'hooks/list': () =>
        hooksOf(
          { trustStatus: 'trusted', enabled: true },
          [{ trustStatus: 'untrusted', enabled: true }],
          false,
        ),
    });
    expect((await collect(handle)).at(-1)).toMatchObject({ reason: 'sandbox_refused' });
    await expect(readFile(join(codexHome, 'config.toml'), 'utf8')).resolves.not.toContain('evil');
    await expect(readFile(join(codexHome, 'config.toml'), 'utf8')).resolves.not.toContain(
      'not-10db',
    );
  });

  it('ends sandbox_refused when the trust cannot be written', async () => {
    const real = codexHomes();
    const homes = (path: string): CodexHome => ({
      path: real(path).path,
      emptyHome: real(path).emptyHome,
      prepare: (dir) => real(path).prepare(dir),
      trustGuardHook: () => Promise.reject(new CodexHomeError('config.toml is not valid TOML')),
    });
    const { handle } = startWith(
      { 'hooks/list': () => hooksOf({ trustStatus: 'untrusted', enabled: true }) },
      {},
      { homes },
    );
    expect((await collect(handle)).at(-1)).toMatchObject({
      type: 'ended',
      reason: 'sandbox_refused',
    });
  });

  it('refuses if the hook stays untrusted after it was trusted', async () => {
    const { handle, server } = startWith({
      'hooks/list': () => hooksOf({ trustStatus: 'modified', enabled: true }),
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

describe('the usage read', () => {
  const USAGE = FINE['account/rateLimits/read'];
  const BAD_GATEWAY = { error: { code: -32000, message: 'unexpected status 502 Bad Gateway' } };
  /** Never answered, so the call's deadline ends it. */
  const UNANSWERED = Symbol('unanswered');

  /** A usage read that answers each call with the next of `answers`, the last one ever after. */
  function usageReads(answers: readonly unknown[]): (params: unknown) => unknown {
    let call = 0;
    return () => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return answer === UNANSWERED ? new Promise(() => undefined) : answer;
    };
  }

  const usageCalls = (server: FakeAppServer): number =>
    methods(server).filter((m) => m === 'account/rateLimits/read').length;

  /** A logger that counts the session's waits before it reads the usage again. */
  function recording(): { readonly logger: Logger; readonly waits: () => number } {
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
    return { logger, waits: () => lines.filter((line) => line.includes('asking again')).length };
  }

  /** Starts a session whose usage reads answer `answers`, on a manual clock. */
  function startReading(answers: readonly unknown[], signIn: SignInState = 'signed_in') {
    const clock = new ManualClock();
    const { logger, waits } = recording();
    const started = startWith(
      { 'account/rateLimits/read': usageReads(answers) },
      {},
      { clock, logger, signInCheck: () => Promise.resolve(signIn) },
    );
    /** Lets read `n` fail (its deadline passing, when it is never answered) and the wait after it begin. */
    const failRead = async (n: number, deadline: number): Promise<void> => {
      await vi.waitFor(() => {
        expect(usageCalls(started.server)).toBe(n);
      });
      if (deadline > 0) clock.advance(deadline);
      await vi.waitFor(() => {
        expect(waits()).toBe(n);
      });
    };
    return { ...started, clock, failRead };
  }

  it.each([
    ['a server error', [BAD_GATEWAY, USAGE], 0],
    ['no answer', [UNANSWERED, USAGE], 60_000],
  ])('asks again on the clock after %s, and starts', async (_name, answers, deadline) => {
    const { handle, server, clock, failRead } = startReading(answers);
    await failRead(1, deadline);
    // Not before the wait is over.
    clock.advance(USAGE_READ_RETRY_MS - 1);
    expect(usageCalls(server)).toBe(1);
    clock.advance(1);
    expect(await firstEvent(handle)).toMatchObject({ type: 'started' });
    expect(usageCalls(server)).toBe(2);
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/start');
    });
    await handle.stop();
  });

  it.each([
    ['a server error', BAD_GATEWAY, 0],
    ['no answer', UNANSWERED, 60_000],
  ])(
    'ends the start with error naming the usage read when every try meets %s, and pauses nothing',
    async (_name, answer, deadline) => {
      const { handle, server, clock, failRead } = startReading([answer]);
      for (let n = 1; n < USAGE_READ_TRIES; n += 1) {
        await failRead(n, deadline);
        clock.advance(USAGE_READ_RETRY_MS);
      }
      await vi.waitFor(() => {
        expect(usageCalls(server)).toBe(USAGE_READ_TRIES);
      });
      if (deadline > 0) clock.advance(deadline);
      const events = await collect(handle);
      const ended = events.at(-1);
      expect(ended).toMatchObject({ type: 'ended', reason: 'error' });
      expect(ended).not.toHaveProperty('refusal');
      expect(JSON.stringify(ended)).toContain('usage read');
      expect(JSON.stringify(ended)).toContain(`${String(USAGE_READ_TRIES)} tries`);
      expect(JSON.stringify(ended)).not.toContain('502');
      expect(events.filter((e) => e.type === 'started')).toEqual([]);
      expect(usageCalls(server)).toBe(USAGE_READ_TRIES);
      expect(methods(server)).not.toContain('turn/start');
      expect(server.killed()).toBe(true);
    },
  );

  it('waits for its sign-in when codex login status says the home is signed out', async () => {
    const { handle, clock, failRead } = startReading([BAD_GATEWAY], 'signed_out');
    for (let n = 1; n < USAGE_READ_TRIES; n += 1) {
      await failRead(n, 0);
      clock.advance(USAGE_READ_RETRY_MS);
    }
    expect((await collect(handle)).at(-1)).toMatchObject({
      type: 'ended',
      reason: 'account_refused',
      refusal: { problem: AccountProblem.SignedOut },
    });
  });

  it('does not ask again once the session is stopped during the wait', async () => {
    const { handle, server, clock, failRead } = startReading([BAD_GATEWAY]);
    await failRead(1, 0);
    await handle.stop();
    clock.advance(USAGE_READ_RETRY_MS * USAGE_READ_TRIES);
    expect((await collect(handle)).at(-1)).toMatchObject({ type: 'ended', reason: 'stopped' });
    expect(usageCalls(server)).toBe(1);
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
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'sandbox_refused' });
    expect(JSON.stringify(events.at(-1))).toContain('hooks/list');
    expect(server.killed()).toBe(true);
    expect(methods(server)).not.toContain('turn/start');
  });

  it('ends an unanswered account read with error when codex login status says it is signed in', async () => {
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
    const ended = (await collect(handle)).at(-1);
    expect(ended).toMatchObject({ type: 'ended', reason: 'error' });
    expect(ended).not.toHaveProperty('refusal');
    expect(JSON.stringify(ended)).toContain('60 s');
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

  it('ends as a refused model when Codex refuses it at the thread, and pauses nothing', async () => {
    const { handle, server } = startWith({
      'thread/start': { error: { code: -32600, message: 'The model gpt-5.6-sol does not exist' } },
    });
    const ended = (await collect(handle)).at(-1);
    expect(ended).toEqual({
      type: 'ended',
      reason: 'model_refused',
      message: 'Codex refused the model "gpt-5.6-sol" on this account.',
    });
    expect(methods(server)).not.toContain('turn/start');
    expect(server.killed()).toBe(true);
  });

  it('ends as a refused model when the first turn is refused for it', async () => {
    const { handle, server } = startWith({
      'turn/start': { error: { code: -32600, message: 'unknown model gpt-5.6-sol' } },
    });
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({
      type: 'ended',
      reason: 'model_refused',
      message: 'Codex refused the model "gpt-5.6-sol" on this account.',
    });
    expect(events.at(-1)).not.toHaveProperty('refusal');
    expect(server.killed()).toBe(true);
  });

  it('ends as an ordinary error when the first turn fails with a transient error naming the model', async () => {
    const { handle } = startWith({
      'turn/start': { error: { code: -32603, message: 'gpt-5.6-sol is at capacity' } },
    });
    const ended = (await collect(handle)).at(-1);
    expect(ended).toMatchObject({ type: 'ended', reason: 'error' });
    expect(JSON.stringify(ended)).not.toContain('refused the model');
  });

  it('ends as an ordinary error when the first turn is an invalid request naming the model but not refusing it', async () => {
    const { handle } = startWith({
      'turn/start': {
        error: { code: -32600, message: 'gpt-5.6-sol: context window exceeded' },
      },
    });
    const ended = (await collect(handle)).at(-1);
    expect(ended).toMatchObject({ type: 'ended', reason: 'error' });
    expect(JSON.stringify(ended)).not.toContain('refused the model');
  });

  it('ends as an ordinary error when the first turn fails naming no requested model', async () => {
    const { handle } = startWith({
      'turn/start': { error: { code: -32600, message: 'model context window exceeded' } },
    });
    const ended = (await collect(handle)).at(-1);
    expect(ended).toMatchObject({ type: 'ended', reason: 'error' });
    expect(JSON.stringify(ended)).not.toContain('refused the model');
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

const THREAD = 'thr-1';
const turnStarted = (id: string) => ({
  threadId: THREAD,
  turn: { id, status: 'inProgress' },
});
const turnFailed = (codexErrorInfo: unknown, message: string, id = 'turn-1') => ({
  threadId: THREAD,
  turn: { id, status: 'failed', error: { message, codexErrorInfo } },
});
const weekWindow = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 96.5, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
    secondary: null,
  },
};

interface Running {
  readonly handle: SessionHandle;
  readonly server: FakeAppServer;
  readonly seen: SessionEvent[];
  readonly clock: ManualClock;
}

/** A session whose events are collected as they come, with its first turn begun. */
async function inTurn(
  script: Record<string, unknown> = {},
  depsOver: Partial<CodexSessionDeps> = {},
): Promise<Running> {
  const clock = new ManualClock();
  const { handle, server } = startWith(
    { 'turn/steer': {}, 'turn/interrupt': {}, ...script },
    {},
    { clock, ...depsOver },
  );
  const seen: SessionEvent[] = [];
  void (async () => {
    for await (const event of handle.events) seen.push(event);
  })();
  await vi.waitFor(() => {
    expect(methods(server)).toContain('turn/start');
  });
  server.notify('turn/started', turnStarted('turn-1'));
  await settled({ handle, server, seen, clock });
  return { handle, server, seen, clock };
}

/** Waits until every notification written so far has been handled, which a later one's event proves. */
async function settled(running: Running): Promise<void> {
  const before = running.seen.length;
  running.server.notify('item/completed', {
    threadId: THREAD,
    turnId: 'turn-1',
    item: { type: 'contextCompaction', id: 'c1' },
  });
  await vi.waitFor(() => {
    expect(running.seen.length).toBeGreaterThan(before);
  });
}

/** A stored picture, as a lane message carries it: its bytes and the file they were read from. */
const picture = (path: string): ShapeImage => ({ mediaType: 'image/png', data: 'iVBO', path });

const types = (seen: readonly SessionEvent[]): string[] => seen.map((e) => e.type);
const endedOf = (seen: readonly SessionEvent[]): SessionEvent[] =>
  seen.filter((e) => e.type === 'ended');

describe('the turns', () => {
  it('sends text as turn/steer during a turn and turn/start between turns', async () => {
    const running = await inTurn();
    const { handle, server } = running;
    handle.send('more');
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/steer');
    });
    expect(sentParams(server, 'turn/steer')).toEqual({
      threadId: THREAD,
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'more' }],
    });

    server.notify('turn/completed', {
      threadId: THREAD,
      turn: { id: 'turn-1', status: 'completed' },
    });
    await settled(running);
    handle.send('next');
    await vi.waitFor(() => {
      expect(methods(server).filter((m) => m === 'turn/start')).toHaveLength(2);
    });
    const second = server.sent().filter((r) => r.method === 'turn/start')[1];
    expect(second?.params).toMatchObject({
      threadId: THREAD,
      input: [{ type: 'text', text: 'next' }],
      approvalPolicy: 'never',
      model: 'gpt-5.6-sol',
      effort: 'low',
    });
  });

  it('starts a turn for a message whose steer lost the race with the end of its turn', async () => {
    const running = await inTurn({
      'turn/steer': { error: { code: -32600, message: 'expected turn turn-1 is not active' } },
    });
    running.handle.send('late');
    await vi.waitFor(() => {
      expect(methods(running.server).filter((m) => m === 'turn/start')).toHaveLength(2);
    });
    expect(endedOf(running.seen)).toEqual([]);
  });

  it('delivers messages in the order they were sent', async () => {
    const running = await inTurn();
    running.handle.send('one');
    running.handle.send('two');
    await vi.waitFor(() => {
      expect(methods(running.server).filter((m) => m === 'turn/steer')).toHaveLength(2);
    });
    const texts = running.server
      .sent()
      .filter((r) => r.method === 'turn/steer')
      .map((r) => JSON.stringify(r.params));
    expect(texts[0]).toContain('one');
    expect(texts[1]).toContain('two');
  });

  it('queues a message sent before the thread exists and steers it once the first turn began', async () => {
    const { handle, server } = startWith({ 'turn/steer': {} });
    handle.send('hand off');
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/steer');
    });
    expect(sentParams(server, 'turn/steer')).toEqual({
      threadId: THREAD,
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'hand off' }],
    });
  });

  it("sends a message's pictures as local images after its text, in order, whether it steers or starts a turn", async () => {
    const running = await inTurn();
    const { handle, server } = running;
    handle.send('look', [picture('/data/a.png'), picture('/data/b.png')]);
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/steer');
    });
    expect(sentParams(server, 'turn/steer')).toMatchObject({
      input: [
        { type: 'text', text: 'look' },
        { type: 'localImage', path: '/data/a.png' },
        { type: 'localImage', path: '/data/b.png' },
      ],
    });
    server.notify('turn/completed', {
      threadId: THREAD,
      turn: { id: 'turn-1', status: 'completed' },
    });
    await settled(running);
    handle.send('again', [picture('/data/c.png')]);
    await vi.waitFor(() => {
      expect(methods(server).filter((m) => m === 'turn/start')).toHaveLength(2);
    });
    expect(server.sent().filter((r) => r.method === 'turn/start')[1]?.params).toMatchObject({
      input: [
        { type: 'text', text: 'again' },
        { type: 'localImage', path: '/data/c.png' },
      ],
    });
  });

  it("sends the prompt's pictures with the first turn, and a picture with no file as an image of its bytes", async () => {
    const { handle, server } = startWith(
      {},
      { images: [picture('/data/a.png'), { mediaType: 'image/jpeg', data: 'QUJD' }] },
    );
    await firstEvent(handle);
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/start');
    });
    expect(sentParams(server, 'turn/start')).toMatchObject({
      input: [
        { type: 'text', text: 'Do the task' },
        { type: 'localImage', path: '/data/a.png' },
        { type: 'image', url: 'data:image/jpeg;base64,QUJD' },
      ],
    });
  });

  it('sends each message under its client uuid, and reports the uuid once a turn took the message', async () => {
    const promptUuid = 'c0ffee00-0000-4000-8000-000000000001';
    const steered = 'c0ffee00-0000-4000-8000-000000000002';
    const started = 'c0ffee00-0000-4000-8000-000000000003';
    const clock = new ManualClock();
    const { handle, server } = startWith(
      { 'turn/steer': {}, 'turn/interrupt': {} },
      { promptUuid },
      { clock },
    );
    const seen: SessionEvent[] = [];
    void (async () => {
      for await (const event of handle.events) seen.push(event);
    })();
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/start');
    });
    expect(sentParams(server, 'turn/start')).toMatchObject({ clientUserMessageId: promptUuid });
    server.notify('turn/started', turnStarted('turn-1'));
    const running = { handle, server, seen, clock };
    await settled(running);
    handle.send('more', [], steered);
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/steer');
    });
    expect(sentParams(server, 'turn/steer')).toMatchObject({ clientUserMessageId: steered });
    server.notify('item/completed', {
      threadId: THREAD,
      turnId: 'turn-1',
      item: { type: 'userMessage', id: 'u2', clientId: steered, content: [] },
    });
    // Recorded is not yet taken: the model's answer after it is the evidence.
    await settled(running);
    expect(seen.filter((e) => e.type === 'consumed')).toEqual([]);
    server.notify('item/completed', {
      threadId: THREAD,
      turnId: 'turn-1',
      item: { type: 'reasoning', id: 'r1' },
    });
    await vi.waitFor(() => {
      expect(seen).toContainEqual({ type: 'consumed', uuids: [steered] });
    });
    server.notify('turn/completed', {
      threadId: THREAD,
      turn: { id: 'turn-1', status: 'completed' },
    });
    await settled(running);
    handle.send('next', [], started);
    await vi.waitFor(() => {
      expect(methods(server).filter((m) => m === 'turn/start')).toHaveLength(2);
    });
    expect(server.sent().filter((r) => r.method === 'turn/start')[1]?.params).toMatchObject({
      clientUserMessageId: started,
    });
  });

  it('answers an interrupt with the messages 10db still holds, and starts a turn with them once the interrupted turn ended', async () => {
    const handed = 'c0ffee00-0000-4000-8000-00000000000a';
    const held = 'c0ffee00-0000-4000-8000-00000000000b';
    let answerSteer: () => void = () => undefined;
    const running = await inTurn({
      'turn/steer': () =>
        new Promise((resolve) => {
          answerSteer = () => {
            resolve({ turnId: 'turn-1' });
          };
        }),
    });
    const { handle, server } = running;
    handle.send('first', [], handed);
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/steer');
    });
    handle.send('second', [], held);
    const receipt = handle.interrupt();
    await vi.waitFor(() => {
      expect(methods(server)).toContain('turn/interrupt');
    });
    // The handed message's steer is answered while the turn is stopping: the held one must not be
    // steered into the turn the interrupt ends, which would drop it.
    answerSteer();
    await settled(running);
    server.notify('turn/completed', {
      threadId: THREAD,
      turn: { id: 'turn-1', status: 'interrupted' },
    });
    expect(await receipt).toEqual({ stillQueued: [held] });
    await vi.waitFor(() => {
      expect(methods(server).filter((m) => m === 'turn/start')).toHaveLength(2);
    });
    expect(methods(server).filter((m) => m === 'turn/steer')).toHaveLength(1);
    expect(server.sent().filter((r) => r.method === 'turn/start')[1]?.params).toMatchObject({
      clientUserMessageId: held,
    });
  });

  it('answers an interrupt between turns with nothing still queued, interrupting nothing', async () => {
    const running = await inTurn();
    running.server.notify('turn/completed', {
      threadId: THREAD,
      turn: { id: 'turn-1', status: 'completed' },
    });
    await settled(running);
    expect(await running.handle.interrupt()).toEqual({ stillQueued: [] });
    expect(methods(running.server)).not.toContain('turn/interrupt');
  });

  it('ends the wait for an interrupted turn after the grace when Codex never reports it ended', async () => {
    const running = await inTurn({}, { stopGraceMs: 2_000 });
    let answered = false;
    const receipt = running.handle.interrupt().then((r) => {
      answered = true;
      return r;
    });
    await vi.waitFor(() => {
      expect(methods(running.server)).toContain('turn/interrupt');
    });
    await settled(running);
    expect(answered).toBe(false);
    running.clock.advance(2_000);
    expect(await receipt).toEqual({ stillQueued: [] });
  });

  it('drops a message sent during a start that fails, without throwing or hanging', async () => {
    const { handle, server } = startWith({ 'account/read': { account: null } });
    handle.send('too early');
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({ type: 'ended' });
    expect(methods(server)).not.toContain('turn/steer');
  });

  it('maps what Codex reports during a turn onto session events', async () => {
    const running = await inTurn();
    running.server.notify('item/completed', {
      threadId: THREAD,
      turnId: 'turn-1',
      item: { type: 'agentMessage', text: 'all done' },
    });
    running.server.notify('turn/completed', {
      threadId: THREAD,
      turn: { id: 'turn-1', status: 'completed' },
    });
    await vi.waitFor(() => {
      expect(types(running.seen)).toContain('turn_complete');
    });
    expect(running.seen.at(-1)).toMatchObject({
      type: 'turn_complete',
      text: 'all done',
      costUsd: 0,
    });
  });

  it('ends with error, quoting no email, when a message cannot be delivered', async () => {
    const running = await inTurn({
      'turn/steer': { error: { code: -32000, message: 'me@example.com is over' } },
      'turn/start': (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls === 1
            ? { turn: { id: 'turn-1', status: 'inProgress' } }
            : { error: { code: -32000, message: 'no' } };
        };
      })(),
    });
    running.handle.send('x');
    await vi.waitFor(() => {
      expect(endedOf(running.seen)).toHaveLength(1);
    });
    expect(endedOf(running.seen)[0]).toMatchObject({ reason: 'error' });
    expect(JSON.stringify(running.seen)).not.toContain('me@example.com');
  });
});

describe('limits and failed turns', () => {
  it('turns usageLimitExceeded into rejected, then ended rate_limited', async () => {
    const running = await inTurn();
    running.server.notify('account/rateLimits/updated', weekWindow);
    running.server.notify('turn/completed', turnFailed('usageLimitExceeded', 'You hit your limit'));
    await vi.waitFor(() => {
      expect(endedOf(running.seen)).toHaveLength(1);
    });
    expect(running.seen.slice(-3)).toEqual([
      expect.objectContaining({ type: 'rate_limit', status: 'allowed', limitType: 'seven_day' }),
      {
        type: 'rate_limit',
        status: 'rejected',
        resetsAt: new Date(1_800_000_000_000),
        utilization: 0.965,
        limitType: 'seven_day',
      },
      expect.objectContaining({ type: 'ended', reason: 'rate_limited' }),
    ]);
    expect(running.server.killed()).toBe(true);
  });

  it('reads account/rateLimits/read when no window has been seen', async () => {
    const running = await inTurn({
      'account/rateLimits/read': { ...weekWindow, accountId: 'ws-1' },
    });
    running.server.notify('turn/completed', turnFailed('usageLimitExceeded', 'You hit your limit'));
    await vi.waitFor(() => {
      expect(endedOf(running.seen)).toHaveLength(1);
    });
    expect(running.seen.at(-2)).toMatchObject({
      type: 'rate_limit',
      status: 'rejected',
      resetsAt: new Date(1_800_000_000_000),
      limitType: 'seven_day',
    });
    expect(methods(running.server).filter((m) => m === 'account/rateLimits/read')).toHaveLength(2);
  });

  it('reads codexErrorInfo given as an object, and ends rate_limited with no reset when no window has one', async () => {
    const running = await inTurn();
    running.server.notify('turn/completed', turnFailed({ usageLimitExceeded: {} }, 'limit'));
    await vi.waitFor(() => {
      expect(endedOf(running.seen)).toHaveLength(1);
    });
    expect(running.seen.at(-1)).toMatchObject({ reason: 'rate_limited' });
  });

  it('ends account_refused, signed out, on unauthorized, naming no email', async () => {
    const running = await inTurn();
    running.server.notify('turn/completed', turnFailed('unauthorized', 'token for me@example.com'));
    await vi.waitFor(() => {
      expect(endedOf(running.seen)).toHaveLength(1);
    });
    expect(running.seen.at(-1)).toMatchObject({
      type: 'ended',
      reason: 'account_refused',
      refusal: { problem: AccountProblem.SignedOut },
    });
    expect(JSON.stringify(running.seen)).not.toContain('me@example.com');
    expect(running.server.killed()).toBe(true);
  });

  it('ends turn_complete with result error on another failed turn, and goes on', async () => {
    const running = await inTurn();
    running.server.notify('turn/completed', turnFailed({ httpConnectionFailed: {} }, 'offline'));
    await vi.waitFor(() => {
      expect(types(running.seen)).toContain('turn_complete');
    });
    expect(running.seen.at(-1)).toMatchObject({ type: 'turn_complete', result: 'error' });
    expect(endedOf(running.seen)).toEqual([]);
    expect(running.server.killed()).toBe(false);
  });

  it('ends as a refused model when a turn is refused for the model it was given', async () => {
    const running = await inTurn();
    running.server.notify(
      'turn/completed',
      turnFailed('badRequest', 'The model gpt-5.6-sol does not exist'),
    );
    await vi.waitFor(() => {
      expect(endedOf(running.seen)).toHaveLength(1);
    });
    expect(running.seen.at(-1)).toEqual({
      type: 'ended',
      reason: 'model_refused',
      message: 'Codex refused the model "gpt-5.6-sol" on this account.',
    });
  });

  it.each([
    [
      'a bad request that does not name the model',
      'badRequest',
      'a model of tidiness, no. Bad input',
    ],
    [
      'a bad request that names the model without refusing it',
      'badRequest',
      'The prompt sent to gpt-5.6-sol is too long',
    ],
    ['another error that names the model', 'internalServerError', 'gpt-5.6-sol fell over'],
  ])('keeps the session going on %s', async (_name, info, message) => {
    const running = await inTurn();
    running.server.notify('turn/completed', turnFailed(info, message));
    await vi.waitFor(() => {
      expect(types(running.seen)).toContain('turn_complete');
    });
    expect(running.seen.at(-1)).toMatchObject({ type: 'turn_complete', result: 'error' });
    expect(endedOf(running.seen)).toEqual([]);
  });

  it('logs only the method of a notification with a bad shape, and goes on', async () => {
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
    const running = await inTurn({}, { logger });
    running.server.notify('turn/completed', { threadId: THREAD, turn: 'secret@example.com' });
    await settled(running);
    expect(lines.join('\n')).toContain('turn/completed');
    expect(lines.join('\n')).not.toContain('secret@example.com');
    expect(endedOf(running.seen)).toEqual([]);
  });
});

describe('the end of a session', () => {
  it('ends with error when the process exits unasked, with the end of its stderr and no log line of it', async () => {
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
    const running = await inTurn({}, { logger });
    running.server.writeStderr('the disk is gone');
    await settled(running);
    running.server.exit(1);
    await vi.waitFor(() => {
      expect(endedOf(running.seen)).toHaveLength(1);
    });
    const ended = running.seen.at(-1);
    expect(ended).toMatchObject({ type: 'ended', reason: 'error' });
    expect(JSON.stringify(ended)).toContain('the disk is gone');
    expect(lines.join('\n')).not.toContain('the disk is gone');
  });

  it('stop interrupts the turn, ends the process and emits one ended', async () => {
    const running = await inTurn();
    await running.handle.stop();
    expect(sentParams(running.server, 'turn/interrupt')).toEqual({
      threadId: THREAD,
      turnId: 'turn-1',
    });
    expect(running.server.killed()).toBe(true);
    await vi.waitFor(() => {
      expect(endedOf(running.seen)).toHaveLength(1);
    });
    expect(endedOf(running.seen)).toEqual([{ type: 'ended', reason: 'stopped', message: null }]);
  });

  it('stop interrupts nothing between turns', async () => {
    const running = await inTurn();
    running.server.notify('turn/completed', {
      threadId: THREAD,
      turn: { id: 'turn-1', status: 'completed' },
    });
    await settled(running);
    await running.handle.stop();
    expect(methods(running.server)).not.toContain('turn/interrupt');
    expect(running.server.killed()).toBe(true);
  });

  it('stop ends the process after the grace when the interrupt goes unanswered', async () => {
    const running = await inTurn(
      { 'turn/interrupt': () => new Promise(() => undefined) },
      { stopGraceMs: 2_000 },
    );
    let stopped = false;
    const stopping = running.handle.stop().then(() => {
      stopped = true;
    });
    await vi.waitFor(() => {
      expect(methods(running.server)).toContain('turn/interrupt');
    });
    expect(running.server.killed()).toBe(false);
    running.clock.advance(1_999);
    await Promise.resolve();
    expect(stopped).toBe(false);
    running.clock.advance(1);
    await stopping;
    expect(running.server.killed()).toBe(true);
    await vi.waitFor(() => {
      expect(endedOf(running.seen)).toHaveLength(1);
    });
  });

  it('emits exactly one ended when the process exits during stop', async () => {
    const running = await inTurn({ 'turn/interrupt': () => new Promise(() => undefined) });
    const stopping = running.handle.stop();
    await vi.waitFor(() => {
      expect(methods(running.server)).toContain('turn/interrupt');
    });
    running.server.exit(0);
    await stopping;
    await vi.waitFor(() => {
      expect(endedOf(running.seen)).toHaveLength(1);
    });
    expect(endedOf(running.seen)).toEqual([{ type: 'ended', reason: 'stopped', message: null }]);
  });

  it('does not say no prompt was sent once the session has started', async () => {
    const { handle } = startWith({
      'turn/start': { error: { code: -32000, message: 'the turn could not begin' } },
    });
    const events = await collect(handle);
    expect(events.map((e) => e.type)).toEqual(['started', 'ended']);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'error' });
    expect(JSON.stringify(events.at(-1))).not.toContain('No prompt was sent');
  });
});

describe('codexThreadConfig', () => {
  it('declares the 10db server with its bearer variable, approval mode and tool timeout', () => {
    const config = codexThreadConfig(specOf());
    expect(config['mcp_servers']).toEqual({
      '10db': {
        url: 'http://127.0.0.1:7777/mcp',
        bearer_token_env_var: 'TENDB_MCP_TOKEN',
        required: true,
        default_tools_approval_mode: 'approve',
        tool_timeout_sec: 905,
      },
    });
    expect(JSON.stringify(config)).not.toContain('tok-secret-1');
  });

  /** A sandbox whose profile is `settings` over the base fixture, checked out at /w/lane. */
  const sandboxWith = (settings: {
    filesystem?: Partial<LaneSandboxSpec['settings']['filesystem']>;
    network?: Partial<LaneSandboxSpec['settings']['network']>;
  }): LaneSandboxSpec => ({
    ...sandbox,
    settings: {
      ...sandbox.settings,
      filesystem: { ...sandbox.settings.filesystem, ...settings.filesystem },
      network: { ...sandbox.settings.network, ...settings.network },
    },
  });
  const laneOf = (config: Record<string, unknown>) =>
    (config['permissions'] as { lane: { filesystem: unknown; network: unknown } }).lane;

  it('translates the lane profile into the lane permission profile', () => {
    const lane = sandboxWith({
      filesystem: {
        denyRead: ['/', '/w/lane/.env.local'],
        allowRead: ['/usr', '/h/install[s]', '/h/installs/*'],
        allowWrite: ['/tmp/lane-1'],
        denyWrite: ['/w/lane/nested', '/w/other'],
      },
      network: {
        allowedDomains: ['registry.npmjs.org'],
        allowLocalBinding: true,
        allowUnixSockets: ['/tmp/lane-1'],
        allowMachLookup: ['com.apple.FSEvents'],
      },
    });
    const config = codexThreadConfig(specOf({ sandbox: lane }));
    const { filesystem, network } = laneOf(config);
    expect(filesystem).toEqual({
      ':minimal': 'read',
      '/usr': 'read',
      '/w/lane': 'write',
      // A path that doesn't exist yet sits under the real path of its dir: /private/tmp on macOS.
      [join(realpathSync('/tmp'), 'lane-1')]: 'write',
      '/w/lane/.env.local': 'deny',
      '/w/lane/nested': 'read',
    });
    expect(network).toEqual({
      enabled: true,
      mode: 'full',
      domains: { 'registry.npmjs.org': 'allow' },
      allow_local_binding: true,
      unix_sockets: { '/tmp/lane-1': 'allow' },
    });
    expect(config['shell_environment_policy']).toEqual({
      inherit: 'none',
      set: { PATH: '/usr/bin', TMPDIR: '/tmp/lane-1' },
    });
  });

  it.each([
    {
      name: 'a denyWrite under a denied directory stays denied by its ancestor',
      filesystem: { denyRead: ['/', '/w/lane/secret'], denyWrite: ['/w/lane/secret/sub'] },
      absent: '/w/lane/secret/sub',
    },
  ])('does not reopen a denied directory: $name', ({ filesystem, absent }) => {
    const { filesystem: result } = laneOf(
      codexThreadConfig(specOf({ sandbox: sandboxWith({ filesystem }) })),
    );
    expect(result).not.toHaveProperty(absent);
    expect(result).toMatchObject({ '/w/lane/secret': 'deny' });
  });

  it('drops a read entry that is a link whose target is not granted, and keeps one entry per real path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lanelink-'));
    try {
      const target = join(dir, 'target');
      const granted = join(dir, 'granted');
      await mkdir(target);
      await mkdir(granted);
      const open = join(dir, 'open-link');
      const closed = join(dir, 'closed-link');
      await symlink(granted, open);
      await symlink(target, closed);
      const { filesystem } = laneOf(
        codexThreadConfig(
          specOf({ sandbox: sandboxWith({ filesystem: { allowRead: [granted, open, closed] } }) }),
        ),
      );
      const keys = Object.keys(filesystem as Record<string, string>);
      // A link and its target are one entry, under the real path: Codex repeats every read and deny
      // entry in its temp-dir rules, and a list with each alias outgrows macOS's sandbox compiler.
      expect(filesystem).toMatchObject({ [await realpath(granted)]: 'read' });
      expect(keys).not.toContain(open);
      expect(keys).not.toContain(closed);
      expect(keys).not.toContain(await realpath(target));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** A lane over a real checkout and a real denied secrets dir, for rows that need real links. */
  interface LinkWorld {
    readonly checkout: string;
    readonly secrets: string;
    readonly home: string;
  }
  it.each<{
    name: string;
    build: (w: LinkWorld) => Promise<Partial<LaneSandboxSpec['settings']['filesystem']>>;
    expected: (w: LinkWorld) => Record<string, string>;
    absent: (w: LinkWorld) => string[];
  }>([
    {
      name: 'a denyWrite link to a denied dir keeps the deny and the link unwritable',
      build: async (w) => {
        await symlink(w.secrets, join(w.checkout, '.git'));
        return { denyRead: ['/', w.secrets], denyWrite: [join(w.checkout, '.git')] };
      },
      // Codex follows a link entry, so the link's own entry must not be a read of what it points to.
      expected: (w) => ({ [w.secrets]: 'deny', [join(w.checkout, '.git')]: 'deny' }),
      absent: () => [],
    },
    {
      name: 'a denyWrite link to a file in a denied dir reopens nothing',
      build: async (w) => {
        await symlink(join(w.secrets, 'auth.json'), join(w.checkout, 'nested'));
        return { denyRead: ['/', w.secrets], denyWrite: [join(w.checkout, 'nested')] };
      },
      expected: (w) => ({ [w.secrets]: 'deny', [join(w.checkout, 'nested')]: 'deny' }),
      absent: (w) => [join(w.secrets, 'auth.json')],
    },
    {
      // Codex also stops the checkout's writes under this map, since the link's target holds the
      // checkout: the lane fails closed.
      name: 'a denyWrite link to / is denied, so it opens nothing',
      build: async (w) => {
        await symlink('/', join(w.checkout, 'slash'));
        return { denyWrite: [join(w.checkout, 'slash')] };
      },
      expected: (w) => ({ [join(w.checkout, 'slash')]: 'deny' }),
      absent: () => ['/'],
    },
    {
      name: 'a denyWrite link to a readable git dir elsewhere stays readable, not writable',
      build: async (w) => {
        const gitDir = join(w.home, 'repo.git');
        await mkdir(gitDir);
        await symlink(gitDir, join(w.checkout, '.git'));
        return { allowRead: [gitDir], denyWrite: [join(w.checkout, '.git')] };
      },
      expected: (w) => ({ [join(w.home, 'repo.git')]: 'read', [join(w.checkout, '.git')]: 'read' }),
      absent: () => [],
    },
    {
      name: 'a read link into a denied dir under a granted one reopens nothing',
      build: async (w) => {
        const inner = join(w.home, '.codex');
        await mkdir(inner);
        await writeFile(join(inner, 'auth.json'), '{}');
        await symlink(join(inner, 'auth.json'), join(w.home, 'notes'));
        return { allowRead: [w.home, join(w.home, 'notes')], denyRead: ['/', inner] };
      },
      expected: (w) => ({ [w.home]: 'read', [join(w.home, '.codex')]: 'deny' }),
      absent: (w) => [join(w.home, 'notes'), join(w.home, '.codex', 'auth.json')],
    },
    {
      name: 'a missing path takes the real path of the dir it would be in',
      build: () =>
        Promise.resolve({
          allowWrite: [tmpdir()],
          denyRead: ['/', join(tmpdir(), 'not-made-yet')],
        }),
      expected: () => ({ [join(realpathSync(tmpdir()), 'not-made-yet')]: 'deny' }),
      absent: () => [],
    },
    {
      name: 'a denyWrite spelled by its real path narrows a write granted through a link',
      build: async (w) => {
        const scratch = join(w.home, 'scratch');
        await mkdir(scratch);
        await symlink(scratch, join(w.home, 'scratch-link'));
        return { allowWrite: [join(w.home, 'scratch-link')], denyWrite: [scratch] };
      },
      expected: (w) => ({ [join(w.home, 'scratch')]: 'read' }),
      absent: () => [],
    },
    {
      name: 'a denyWrite link spelled through an alias of its writable root still gets an entry',
      build: async (w) => {
        const scratch = join(w.home, 'scratch');
        await mkdir(scratch);
        await symlink(w.home, join(w.checkout, 'home-alias'));
        await symlink(w.secrets, join(scratch, 'lnk'));
        return {
          allowWrite: [scratch],
          denyRead: ['/', w.secrets],
          denyWrite: [join(w.checkout, 'home-alias', 'scratch', 'lnk')],
        };
      },
      expected: (w) => ({ [join(w.home, 'scratch', 'lnk')]: 'deny' }),
      absent: () => [],
    },
    {
      name: 'a read link in one denied tree to a file in another reopens nothing',
      build: async (w) => {
        const secret = join(w.home, 'secret');
        const ssh = join(w.home, 'ssh');
        await mkdir(secret);
        await mkdir(ssh);
        await writeFile(join(ssh, 'id'), 'key');
        await symlink(join(ssh, 'id'), join(secret, 'tossh'));
        return { allowRead: [w.home, join(secret, 'tossh')], denyRead: ['/', secret, ssh] };
      },
      expected: (w) => ({ [join(w.home, 'ssh')]: 'deny' }),
      absent: (w) => [join(w.home, 'ssh', 'id'), join(w.home, 'secret', 'tossh')],
    },
  ])('resolves links without opening more: $name', async ({ build, expected, absent }) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'lanelinks-')));
    try {
      const w: LinkWorld = {
        checkout: join(dir, 'checkout'),
        secrets: join(dir, 'secrets'),
        home: join(dir, 'home'),
      };
      await mkdir(w.checkout);
      await mkdir(w.secrets);
      await mkdir(w.home);
      await writeFile(join(w.secrets, 'auth.json'), '{}');
      const filesystem = await build(w);
      const { filesystem: result } = laneOf(
        codexThreadConfig(
          specOf({ sandbox: { ...sandboxWith({ filesystem }), checkout: w.checkout } }),
        ),
      );
      expect(result).toMatchObject(expected(w));
      const keys = Object.keys(result as Record<string, string>);
      for (const path of absent(w)) expect(keys).not.toContain(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes an empty host list through, which blocks every host', () => {
    const { network } = laneOf(codexThreadConfig(specOf()));
    expect(network).toMatchObject({ enabled: true, mode: 'full', domains: {} });
  });

  it.each([
    {
      name: 'a deny beats a write on the same path',
      filesystem: { allowWrite: ['/x'], denyRead: ['/', '/x'] },
      expected: { '/x': 'deny' },
    },
    {
      name: 'a write beats a read on the same path',
      filesystem: { allowRead: ['/x'], allowWrite: ['/x'] },
      expected: { '/x': 'write' },
    },
    {
      name: 'a denyWrite on a writable path narrows it to read',
      filesystem: { allowWrite: ['/x'], denyWrite: ['/x'] },
      expected: { '/x': 'read' },
    },
    {
      name: 'a denyWrite does not open a read-denied path',
      filesystem: { denyRead: ['/', '/w/lane/s'], denyWrite: ['/w/lane/s'] },
      expected: { '/w/lane/s': 'deny' },
    },
  ])('resolves overlapping entries: $name', ({ filesystem, expected }) => {
    const { filesystem: result } = laneOf(
      codexThreadConfig(specOf({ sandbox: sandboxWith({ filesystem }) })),
    );
    expect(result).toMatchObject(expected);
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

describe('the guard socket', () => {
  /** Posts a Bash call to the session's socket; the status and body come back. */
  function post(
    spec: SessionSpec,
    command: string,
  ): Promise<{ status: number | undefined; body: string }> {
    return new Promise((done, fail) => {
      const req = request(
        {
          socketPath: guardSocketPath(join(root, 'run'), spec.sessionId),
          path: '/pre-tool-use',
          method: 'POST',
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            done({ status: res.statusCode, body });
          });
        },
      );
      req.on('error', fail);
      req.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
    });
  }

  async function running(specOver: Partial<SessionSpec>): Promise<{
    handle: SessionHandle;
    server: FakeAppServer;
    spec: SessionSpec;
  }> {
    const started = startWith({ 'turn/interrupt': {} }, specOver);
    await vi.waitFor(() => {
      expect(methods(started.server)).toContain('turn/start');
    });
    started.server.notify('turn/started', turnStarted('turn-1'));
    return started;
  }

  it.skipIf(SANDBOXED)(
    'answers the hook while the session runs and is gone once it ends',
    async () => {
      const { handle, spec } = await running({
        preToolUse: ({ input }) =>
          JSON.stringify(input).includes('push')
            ? { decision: 'deny', reason: 'push is refused' }
            : { decision: 'allow' },
      });
      expect(await post(spec, 'ls')).toEqual({ status: 200, body: '' });
      const refused = await post(spec, 'git push');
      expect(refused.status).toBe(200);
      expect(refused.body).toContain('"permissionDecision":"deny"');
      await handle.stop();
      await expect(post(spec, 'ls')).rejects.toThrow();
    },
  );

  it.skipIf(SANDBOXED)('interrupts the turn when the broker says to', async () => {
    const { handle, server, spec } = await running({
      preToolUse: () => ({ decision: 'ask', reason: 'unread' }),
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'stop', interrupt: true }),
    });
    const refused = await post(spec, 'make');
    expect(refused.body).toContain('stop');
    await vi.waitFor(() => {
      expect(sentParams(server, 'turn/interrupt')).toEqual({ threadId: THREAD, turnId: 'turn-1' });
    });
    await handle.stop();
  });

  it('refuses the session, sending no prompt, when the socket cannot be opened', async () => {
    await writeFile(join(root, 'run'), 'a file where the socket directory should be');
    const { handle, server } = startWith({});
    const events = await collect(handle);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'sandbox_refused' });
    // The socket opens before the process starts, so there is no process to send anything to.
    expect(methods(server)).toEqual([]);
  });
});
