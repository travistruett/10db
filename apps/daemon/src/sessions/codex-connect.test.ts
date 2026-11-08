import { AccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { capturingLogger } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { startCodexLogin } from './codex-connect';
import { fakeAppServer, type FakeAppServer } from './codex-test-support';
import { AccountLoginError, LOGIN_MS, type AccountLogin } from './types';
import { CODEX_VERIFIED_ON } from '../environment';

const AUTH_URL = 'https://auth.openai.com/oauth/authorize?state=abc';
const spec = { cwd: '/d', env: { CODEX_HOME: '/h/codex' }, kind: AccountKind.CodexSignin } as const;
const INITIALIZE = { userAgent: `codex/${CODEX_VERIFIED_ON}`, codexHome: '/h/codex' };
/** An app-server that exits when it is told to stop, as a real one does. */
const appServer = (script: Parameters<typeof fakeAppServer>[0]) =>
  fakeAppServer(script, { exitsOn: 'SIGTERM' });
const STARTED = { type: 'chatgpt', loginId: 'L1', authUrl: AUTH_URL };

function login(server: FakeAppServer, clock = new ManualClock()): Promise<AccountLogin> {
  return startCodexLogin(spec, {
    codexPath: '/opt/codex',
    logger: silentLogger,
    spawn: server.spawn,
    clock,
  });
}

const completed = (loginId: string | null, success: boolean, error: string | null = null) => ({
  loginId,
  success,
  error,
  onboardingEntrypoint: null,
});

describe('what a sign-in logs', () => {
  it('never holds the page address, an email or anything the app-server printed', async () => {
    const logger = capturingLogger();
    const server = fakeAppServer(
      { initialize: INITIALIZE, 'account/login/start': STARTED },
      { exitsOn: 'SIGTERM' },
    );
    const started = await startCodexLogin(spec, {
      codexPath: '/opt/codex',
      logger,
      spawn: server.spawn,
      clock: new ManualClock(),
    });
    server.writeStderr(`open ${AUTH_URL} for me@example.com\n`);
    server.writeLine(`not json ${AUTH_URL} me@example.com`);
    server.notify('account/login/completed', { loginId: 5, note: `${AUTH_URL} me@example.com` });
    server.notify(
      'account/login/completed',
      completed('L1', false, `failed for me@example.com at ${AUTH_URL}`),
    );
    const result = await started.outcome;
    server.exit(1);
    for (const text of [JSON.stringify(result), ...logger.lines()]) {
      expect(text).not.toContain('me@example.com');
      expect(text).not.toContain('state=abc');
      expect(text).not.toContain('auth.openai.com');
    }
    // The checks above mean something only if the unusual lines were logged at all.
    expect(logger.lines().length).toBeGreaterThan(0);
  });
});

describe('startCodexLogin', () => {
  it('asks the app-server for a ChatGPT sign-in and answers its page and nothing else', async () => {
    const server = appServer({
      initialize: INITIALIZE,
      'account/login/start': STARTED,
    });
    const started = await login(server);
    expect(started.authUrl).toBe(AUTH_URL);
    expect(server.sent().map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'account/login/start',
    ]);
    expect(server.sent()[2]?.params).toEqual({ type: 'chatgpt' });
    expect(server.killed()).toBe(false);
  });

  describe('how a started sign-in ends', () => {
    const OVERHEARD = 'boom for me@example.com at /Users/me';
    it.each<{
      name: string;
      end: (server: FakeAppServer, clock: ManualClock) => void;
      outcome: { ok: true } | { ok: false; message: RegExp };
    }>([
      {
        name: 'the matching login completes',
        end: (server) => {
          server.notify('account/login/completed', completed('L1', true));
        },
        outcome: { ok: true },
      },
      {
        name: 'a completion for another login is ignored, then the matching one fails',
        end: (server) => {
          server.notify('account/login/completed', completed('L2', true));
          server.notify('account/login/completed', completed(null, true));
          server.notify('account/login/completed', completed('L1', false, OVERHEARD));
        },
        outcome: { ok: false, message: /^The sign-in did not finish\. Try Connect again\.$/ },
      },
      {
        name: 'the login fails because the callback port is taken',
        end: (server) => {
          server.notify(
            'account/login/completed',
            completed('L1', false, 'Address already in use (os error 48)'),
          );
        },
        outcome: { ok: false, message: /port 1455/ },
      },
      {
        name: 'the login fails with an error that only mentions a number like the port',
        end: (server) => {
          server.notify(
            'account/login/completed',
            completed('L1', false, 'panicked at offset 1455 of the token file'),
          );
        },
        outcome: { ok: false, message: /^The sign-in did not finish/ },
      },
      {
        name: 'the process exits',
        end: (server) => {
          server.exit(1);
        },
        outcome: { ok: false, message: /^Codex stopped before the sign-in finished/ },
      },
      {
        name: 'ten minutes pass',
        end: (_server, clock) => {
          clock.advance(LOGIN_MS);
        },
        outcome: { ok: false, message: /took too long/ },
      },
    ])('$name', async ({ end, outcome }) => {
      const clock = new ManualClock();
      const server = appServer({ initialize: INITIALIZE, 'account/login/start': STARTED });
      const started = await login(server, clock);
      end(server, clock);
      const result = await started.outcome;
      if (outcome.ok) expect(result).toEqual({ ok: true });
      else {
        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.message).toMatch(outcome.message);
        // What the app-server said is never passed on.
        expect(JSON.stringify(result)).not.toContain('me@example.com');
      }
      expect(server.ended()).toBe(true);
      expect(clock.pendingTimers()).toBe(0);
    });

    it('a cancel asks the app-server to cancel that login, then stops it', async () => {
      const server = appServer({
        initialize: INITIALIZE,
        'account/login/start': STARTED,
        'account/login/cancel': { status: 'canceled' },
      });
      const clock = new ManualClock();
      const started = await login(server, clock);
      await started.cancel();
      await expect(started.outcome).resolves.toEqual({
        ok: false,
        message: 'The sign-in was cancelled.',
      });
      expect(server.sent().find((m) => m.method === 'account/login/cancel')?.params).toEqual({
        loginId: 'L1',
      });
      expect(server.ended()).toBe(true);
      expect(clock.pendingTimers()).toBe(0);
    });

    describe('a cancel that Codex answers with a completion for the same login', () => {
      // A live Codex answers {status: 'canceled'} and sends account/login/completed with success false.
      const LIVE_ERROR = 'Login server error: Login was not completed';
      const cancelledLogin = (
        when: (server: FakeAppServer, answer: { status: string }) => unknown,
        exitsOn: NodeJS.Signals,
      ) => {
        const server: FakeAppServer = fakeAppServer(
          {
            initialize: INITIALIZE,
            'account/login/start': STARTED,
            'account/login/cancel': () => when(server, { status: 'canceled' }),
          },
          { exitsOn },
        );
        return server;
      };
      it.each([
        {
          name: 'before the answer to the cancel',
          when: (server: FakeAppServer, answer: { status: string }) => {
            server.notify('account/login/completed', completed('L1', false, LIVE_ERROR));
            return answer;
          },
        },
        {
          name: 'after the answer to the cancel',
          when: (server: FakeAppServer, answer: { status: string }) => {
            setTimeout(() => {
              server.notify('account/login/completed', completed('L1', false, LIVE_ERROR));
            }, 0);
            return answer;
          },
        },
      ])('$name, the outcome is the cancel and not Codex’s words', async ({ when }) => {
        const server = cancelledLogin(when, 'SIGTERM');
        const started = await login(server);
        await started.cancel();
        const result = await started.outcome;
        expect(result).toEqual({ ok: false, message: 'The sign-in was cancelled.' });
        expect(JSON.stringify(result)).not.toContain('Login was not completed');
      });

      it('a login that completed successfully during the cancel is a success, because Codex has written it', async () => {
        const server = cancelledLogin((srv, answer) => {
          srv.notify('account/login/completed', completed('L1', true));
          return answer;
        }, 'SIGTERM');
        const started = await login(server);
        await started.cancel();
        await expect(started.outcome).resolves.toEqual({ ok: true });
      });

      it('while the stopped process is still exiting, the outcome is the cancel', async () => {
        const clock = new ManualClock();
        const server = cancelledLogin((_server, answer) => answer, 'SIGKILL');
        const started = await login(server, clock);
        void started.cancel();
        await new Promise<void>((resolve) => setImmediate(resolve));
        server.notify('account/login/completed', completed('L1', false, LIVE_ERROR));
        await new Promise<void>((resolve) => setImmediate(resolve));
        clock.advance(2_000);
        const result = await started.outcome;
        expect(result).toEqual({ ok: false, message: 'The sign-in was cancelled.' });
        expect(JSON.stringify(result)).not.toContain('Login was not completed');
      });
    });

    it('a cancel the app-server never answers still stops it after two seconds', async () => {
      const server = appServer({
        initialize: INITIALIZE,
        'account/login/start': STARTED,
        'account/login/cancel': () => new Promise<never>(() => undefined),
      });
      const clock = new ManualClock();
      const started = await login(server, clock);
      const cancelled = started.cancel();
      // The fake answers over a stream, so wait for the request to be written before the time passes.
      await Promise.resolve();
      for (let tries = 0; clock.pendingTimers() < 2 && tries < 50; tries += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      clock.advance(2_000);
      await cancelled;
      expect(server.ended()).toBe(true);
    });

    it('settles only once the process has exited, so the callback port is free', async () => {
      const server = fakeAppServer({ initialize: INITIALIZE, 'account/login/start': STARTED });
      const started = await login(server);
      let settled = false;
      void started.outcome.then(() => {
        settled = true;
      });
      server.notify('account/login/completed', completed('L1', true));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(server.signals()).toEqual(['SIGTERM']);
      expect(settled).toBe(false);
      server.exit(0);
      await expect(started.outcome).resolves.toEqual({ ok: true });
    });

    it('kills a process that ignores the stop with SIGKILL after two seconds, then settles', async () => {
      const clock = new ManualClock();
      const server = fakeAppServer(
        { initialize: INITIALIZE, 'account/login/start': STARTED },
        { exitsOn: 'SIGKILL' },
      );
      const started = await login(server, clock);
      server.notify('account/login/completed', completed('L1', true));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(server.ended()).toBe(false);
      clock.advance(2_000);
      await expect(started.outcome).resolves.toEqual({ ok: true });
      expect(server.signals()).toEqual(['SIGTERM', 'SIGKILL']);
      expect(server.ended()).toBe(true);
      expect(clock.pendingTimers()).toBe(0);
    });

    it('a completion that arrives before the start answer is not lost', async () => {
      const server: FakeAppServer = appServer({
        initialize: INITIALIZE,
        'account/login/start': () => {
          server.notify('account/login/completed', completed('L1', true));
          return STARTED;
        },
      });
      const started = await login(server);
      await expect(started.outcome).resolves.toEqual({ ok: true });
    });
  });

  describe('a sign-in that cannot start', () => {
    it.each([
      { name: 'an http page', url: 'http://auth.openai.com/oauth/authorize' },
      { name: 'another host', url: 'https://evil.example/oauth/authorize' },
      {
        name: 'a host that only ends in the right name',
        url: 'https://auth.openai.com.evil.example/',
      },
      { name: 'a host with credentials', url: 'https://auth.openai.com@evil.example/' },
      { name: 'another port', url: 'https://auth.openai.com:8443/oauth/authorize' },
      { name: 'text that is no address', url: 'not a url' },
    ])('refuses $name and stops the app-server', async ({ url }) => {
      const server = appServer({
        initialize: INITIALIZE,
        'account/login/start': { ...STARTED, authUrl: url },
      });
      const failure = await login(server).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AccountLoginError);
      expect(String(failure)).not.toContain('evil');
      expect(server.ended()).toBe(true);
    });

    it.each([
      {
        name: 'the callback port is taken',
        script: {
          initialize: INITIALIZE,
          'account/login/start': { error: { code: -32000, message: 'address already in use' } },
        },
        message: /port 1455/,
      },
      {
        name: 'the app-server fails with a message that only holds a number like the port',
        script: {
          initialize: INITIALIZE,
          'account/login/start': { error: { code: -32000, message: 'crash at offset 1455' } },
        },
        message: /^Codex could not start the sign-in$/,
      },
      {
        name: 'the app-server refuses it',
        script: {
          initialize: INITIALIZE,
          'account/login/start': {
            error: { code: -32000, message: 'secret detail me@example.com' },
          },
        },
        message: /^Codex could not start the sign-in$/,
      },
      {
        name: 'the answer has no login id',
        script: {
          initialize: INITIALIZE,
          'account/login/start': { type: 'chatgpt', authUrl: AUTH_URL },
        },
        message: /^Codex could not start the sign-in$/,
      },
      {
        name: 'the answer is for another kind of login',
        script: { initialize: INITIALIZE, 'account/login/start': { type: 'apiKey' } },
        message: /^Codex could not start the sign-in$/,
      },
    ])('says why when $name', async ({ script, message }) => {
      const server = appServer(script);
      const failure = await login(server).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AccountLoginError);
      expect((failure as AccountLoginError).message).toMatch(message); // narrowed by the instanceof above
      expect((failure as AccountLoginError).message).not.toContain('me@example.com');
      expect(server.ended()).toBe(true);
    });

    it('gives up when the app-server never answers the start', async () => {
      const clock = new ManualClock();
      const server = appServer({
        initialize: INITIALIZE,
        'account/login/start': () => new Promise<never>(() => undefined),
      });
      const pending = login(server, clock).catch((error: unknown) => error);
      clock.advance(30_000);
      await expect(pending).resolves.toBeInstanceOf(AccountLoginError);
      expect(server.ended()).toBe(true);
    });
  });
});
