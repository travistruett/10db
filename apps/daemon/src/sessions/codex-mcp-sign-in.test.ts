import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { homeOutsideTemp, type TempDir } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { CODEX_VERIFIED_ON } from '../environment';
import { silentLogger } from '../log';
import type { CodexHome } from './codex-home';
import { McpAuthState } from './codex-mcp-auth';
import { codexMcpAuthStatus, startCodexMcpSignIn, type McpSignInDeps } from './codex-mcp-sign-in';
import { fakeAppServer, type FakeAppServer } from './codex-test-support';
import { codexYourServers } from './codex-your-servers';
import { LOGIN_MS, McpSignInError, type McpSignInSpec, type YourSessionServer } from './types';
import { AccountKind } from '@10db/contracts';

const AUTH_URL = 'https://linear.example/authorize?state=abc';
const INITIALIZE = { userAgent: `codex/${CODEX_VERIFIED_ON}`, codexHome: '/h/codex' };
const THREAD = { thread: { id: 'thr_1' } };
const SERVER: YourSessionServer = {
  connect: { type: 'http', url: 'https://linear.example/mcp', headers: null },
  claudeOAuth: { clientId: 'cid', scopes: 'read write' },
  codex: {
    enabledTools: null,
    disabledTools: [],
    startupTimeoutSec: null,
    toolTimeoutSec: null,
  },
};
const LOGIN = { authorizationUrl: AUTH_URL, loginId: 'L1' };
const PORT_TEXT = /another program is using it/;

let dir: TempDir | null = null;
afterEach(() => {
  dir?.cleanup();
  dir = null;
});

const appServer = (script: Parameters<typeof fakeAppServer>[0]) =>
  fakeAppServer(script, { exitsOn: 'SIGTERM' });
const scripted = (login: unknown = LOGIN) => ({
  initialize: INITIALIZE,
  'thread/start': THREAD,
  'mcpServer/oauth/login': login,
});

function world(codexHome = '/h/codex') {
  const order: string[] = [];
  const opened: string[] = [];
  const seenEnv: Record<string, string>[] = [];
  const home: CodexHome = {
    path: codexHome,
    emptyHome: join(codexHome, 'home'),
    prepare: () => Promise.resolve(),
    ensureConfig: () => {
      order.push('ensureConfig');
      return Promise.resolve();
    },
    trustGuardHook: () => Promise.resolve(),
  };
  const clock = new ManualClock();
  const deps = (server: FakeAppServer): McpSignInDeps => ({
    codexPath: '/opt/codex',
    logger: silentLogger,
    clock,
    homes: () => home,
    spawn: (_path, env) => {
      order.push('spawn');
      seenEnv.push({ ...env });
      return server.child;
    },
    openPage: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
  });
  const spec = (env: Record<string, string> = { CODEX_HOME: codexHome }): McpSignInSpec => ({
    kind: AccountKind.CodexSignin,
    env,
    name: 'linear',
    server: SERVER,
  });
  return { order, opened, seenEnv, clock, deps, spec };
}

const completed = (over: Record<string, unknown> = {}) => ({
  name: 'linear',
  threadId: 'thr_1',
  loginId: 'L1',
  success: true,
  error: null,
  ...over,
});

describe('startCodexMcpSignIn', () => {
  it('runs in the session home: the config is written before the spawn, with HOME from codexChildHome', async () => {
    const w = world();
    const server = appServer(scripted());
    await startCodexMcpSignIn(w.spec(), w.deps(server));
    expect(w.order).toEqual(['ensureConfig', 'spawn']);
    expect(w.seenEnv[0]).toEqual({
      CODEX_HOME: '/h/codex',
      HOME: join('/h/codex', 'home'),
    });
  });

  it('rejects an env with no CODEX_HOME before any spawn', async () => {
    const w = world();
    const server = appServer(scripted());
    await expect(startCodexMcpSignIn(w.spec({}), w.deps(server))).rejects.toBeInstanceOf(
      McpSignInError,
    );
    expect(w.order).toEqual([]);
  });

  it('starts one thread with exactly the one server, logs it in, and opens the page once', async () => {
    const w = world();
    const server = appServer(scripted());
    await startCodexMcpSignIn(w.spec(), w.deps(server));
    const sent = server.sent();
    expect(sent.map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'mcpServer/oauth/login',
    ]);
    expect(sent[2]?.params).toEqual({
      cwd: join('/h/codex', 'home'),
      ephemeral: true,
      approvalPolicy: 'never',
      config: { mcp_servers: codexYourServers({ yourMcpServers: { linear: SERVER } }) },
    });
    expect(sent[3]?.params).toEqual({
      name: 'linear',
      threadId: 'thr_1',
      timeoutSecs: LOGIN_MS / 1000,
    });
    expect(w.opened).toEqual([AUTH_URL]);
  });

  describe('how a started sign-in ends', () => {
    it.each<{
      name: string;
      login?: unknown;
      end: (server: FakeAppServer, clock: ManualClock) => Promise<void> | void;
      outcome: { ok: true } | { ok: false; message: RegExp };
    }>([
      {
        name: 'the matching completion succeeds',
        end: (s) => {
          s.notify('mcpServer/oauthLogin/completed', completed());
        },
        outcome: { ok: true },
      },
      {
        name: 'failed completions for another thread, server or login are ignored, then the matching one succeeds',
        end: (s) => {
          s.notify(
            'mcpServer/oauthLogin/completed',
            completed({ threadId: 'other', success: false }),
          );
          s.notify('mcpServer/oauthLogin/completed', completed({ name: 'notion', success: false }));
          s.notify('mcpServer/oauthLogin/completed', completed({ loginId: 'L9', success: false }));
          s.notify('mcpServer/oauthLogin/completed', completed());
        },
        outcome: { ok: true },
      },
      {
        name: 'a response with no loginId and a completion with one succeeds',
        login: { authorizationUrl: AUTH_URL },
        end: (s) => {
          s.notify('mcpServer/oauthLogin/completed', completed({ loginId: 'L7' }));
        },
        outcome: { ok: true },
      },
      {
        name: 'a failed completion',
        end: (s) => {
          s.notify(
            'mcpServer/oauthLogin/completed',
            completed({ success: false, error: 'denied for me@example.com' }),
          );
        },
        outcome: { ok: false, message: /^The sign-in didn't finish\. Try Sign in again\.$/ },
      },
      {
        name: 'the callback port is taken',
        end: (s) => {
          s.notify(
            'mcpServer/oauthLogin/completed',
            completed({ success: false, error: 'Address already in use (os error 48)' }),
          );
        },
        outcome: { ok: false, message: PORT_TEXT },
      },
      {
        name: 'LOGIN_MS pass',
        end: (_s, clock) => {
          clock.advance(LOGIN_MS);
        },
        outcome: { ok: false, message: /^The sign-in didn't finish\. Try Sign in again\.$/ },
      },
      {
        name: 'the process exits',
        end: (s) => {
          s.exit(1);
        },
        outcome: { ok: false, message: /^Codex stopped before the sign-in finished/ },
      },
    ])('$name', async ({ login, end, outcome }) => {
      const w = world();
      const server = appServer(scripted(login ?? LOGIN));
      const started = await startCodexMcpSignIn(w.spec(), w.deps(server));
      await end(server, w.clock);
      const result = await started.outcome;
      if (outcome.ok) expect(result).toEqual({ ok: true });
      else {
        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.message).toMatch(outcome.message);
        expect(JSON.stringify(result)).not.toContain('me@example.com');
      }
      expect(server.ended()).toBe(true);
      expect(w.clock.pendingTimers()).toBe(0);
    });

    it('a completion that arrives before the login answer is buffered and matched', async () => {
      const w = world();
      const server = appServer(
        scripted(() => {
          server.notify('mcpServer/oauthLogin/completed', completed());
          return LOGIN;
        }),
      );
      const started = await startCodexMcpSignIn(w.spec(), w.deps(server));
      await expect(started.outcome).resolves.toEqual({ ok: true });
      expect(server.ended()).toBe(true);
    });

    it('a cancel settles as cancelled and closes the child', async () => {
      const w = world();
      const server = appServer(scripted());
      const started = await startCodexMcpSignIn(w.spec(), w.deps(server));
      await started.cancel();
      await expect(started.outcome).resolves.toEqual({
        ok: false,
        message: 'The sign-in was cancelled.',
      });
      expect(server.ended()).toBe(true);
    });
  });

  describe('a login call that fails', () => {
    it('with the port in use says so and closes the child', async () => {
      const w = world();
      const server = appServer(
        scripted({ error: { code: -32000, message: 'Address already in use (os error 48)' } }),
      );
      await expect(startCodexMcpSignIn(w.spec(), w.deps(server))).rejects.toThrow(PORT_TEXT);
      expect(server.ended()).toBe(true);
      expect(w.opened).toEqual([]);
    });

    it('that never answers gives up on the clock and closes the child', async () => {
      const w = world();
      const server = appServer(scripted(() => new Promise<never>(() => undefined)));
      const started = startCodexMcpSignIn(w.spec(), w.deps(server));
      const failure = expect(started).rejects.toBeInstanceOf(McpSignInError);
      await vi.waitFor(() => {
        expect(w.clock.pendingTimers()).toBeGreaterThan(0);
        expect(server.sent().some((m) => m.method === 'mcpServer/oauth/login')).toBe(true);
      });
      w.clock.advance(30_000);
      await failure;
      expect(server.ended()).toBe(true);
    });
  });

  describe('a page 10db will not open', () => {
    it.each([
      ['http', 'http://linear.example/authorize'],
      ['userinfo', 'https://me:pw@linear.example/authorize'],
      ['not a url', 'not a url'],
    ])('%s is never opened and the child is closed', async (_name, url) => {
      const w = world();
      const server = appServer(scripted({ authorizationUrl: url, loginId: 'L1' }));
      await expect(startCodexMcpSignIn(w.spec(), w.deps(server))).rejects.toBeInstanceOf(
        McpSignInError,
      );
      expect(w.opened).toEqual([]);
      expect(server.ended()).toBe(true);
    });
  });

  it('reopen opens the same page again', async () => {
    const w = world();
    const server = appServer(scripted());
    const started = await startCodexMcpSignIn(w.spec(), w.deps(server));
    await started.reopen();
    expect(w.opened).toEqual([AUTH_URL, AUTH_URL]);
  });
});

describe('codexMcpAuthStatus', () => {
  it('reads every given server on one thread of the session home, then closes', async () => {
    dir = homeOutsideTemp('mcp-auth');
    await mkdir(dir.path, { recursive: true });
    const w = world(dir.path);
    const server = appServer({
      initialize: INITIALIZE,
      'thread/start': THREAD,
      'mcpServerStatus/list': {
        data: [
          { name: 'linear', authStatus: 'oAuth' },
          { name: 'notion', authStatus: 'notLoggedIn' },
        ],
        nextCursor: null,
      },
    });
    const read = await codexMcpAuthStatus(
      {
        kind: AccountKind.CodexSignin,
        env: { CODEX_HOME: dir.path },
        servers: { linear: SERVER, notion: SERVER },
      },
      w.deps(server),
    );
    expect(read).toEqual({ linear: McpAuthState.SignedIn, notion: McpAuthState.NotSignedIn });
    expect(w.order).toEqual(['ensureConfig', 'spawn']);
    const start = server.sent().find((m) => m.method === 'thread/start');
    expect(
      Object.keys((start?.params as { config: { mcp_servers: object } }).config.mcp_servers),
    ).toEqual(['linear', 'notion']);
    expect(server.ended()).toBe(true);
  });
});
