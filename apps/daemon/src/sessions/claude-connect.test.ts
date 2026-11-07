import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { capturingLogger } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { spawnLogin, startClaudeLogin, type LoginProcess, type LoginSpawn } from './claude-connect';
import { STOP_GRACE_MS } from './login-stop';
import { LOGIN_MS } from './types';

const spec = {
  cwd: '/d',
  env: { CLAUDE_CONFIG_DIR: '/h/claude', PATH: '/bin' },
  kind: AccountKind.ClaudeSubscription,
} as const;

/**
 * Stands in for the `claude` process: it records how it was started and ends when told to, or on the
 * signal given as `exitsOn` (a real process ends on SIGTERM; one that ignores it needs SIGKILL).
 */
function fakeProcess(exitsOn?: NodeJS.Signals) {
  const started: Parameters<LoginSpawn>[] = [];
  const signals: NodeJS.Signals[] = [];
  const listeners: ((code: number | null) => void)[] = [];
  let ended = false;
  const exit = (code: number | null): void => {
    if (ended) return;
    ended = true;
    for (const listener of listeners) listener(code);
  };
  const child: LoginProcess = {
    kill: (signal) => {
      signals.push(signal);
      if (signal === exitsOn || signal === 'SIGKILL')
        queueMicrotask(() => {
          exit(null);
        });
    },
    onExit: (listener) => {
      listeners.push(listener);
    },
  };
  return {
    spawn: ((...args) => {
      started.push(args);
      return child;
    }) satisfies LoginSpawn,
    started,
    signals: () => [...signals],
    ended: () => ended,
    exit,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function login(
  proc: Pick<ReturnType<typeof fakeProcess>, 'spawn'>,
  clock = new ManualClock(),
  logger = capturingLogger(),
) {
  return startClaudeLogin(spec, { claudePath: '/opt/claude', spawn: proc.spawn, clock, logger });
}

describe('startClaudeLogin', () => {
  it('runs the resolved claude in the given directory with the account env and names no page', async () => {
    const proc = fakeProcess('SIGTERM');
    const started = await login(proc);
    expect(started.authUrl).toBeNull();
    expect(proc.started).toEqual([
      ['/opt/claude', ['auth', 'login', '--claudeai'], { env: spec.env, cwd: '/d' }],
    ]);
    expect(proc.signals()).toEqual([]);
  });

  it.each<{
    name: string;
    end: (proc: ReturnType<typeof fakeProcess>, clock: ManualClock) => void;
    outcome: { ok: true } | { ok: false; message: RegExp };
  }>([
    {
      name: 'it exits 0',
      end: (proc) => {
        proc.exit(0);
      },
      outcome: { ok: true },
    },
    {
      name: 'it exits non-zero',
      end: (proc) => {
        proc.exit(1);
      },
      outcome: { ok: false, message: /did not finish the sign-in/ },
    },
    {
      name: 'it could not start (a null exit)',
      end: (proc) => {
        proc.exit(null);
      },
      outcome: { ok: false, message: /did not finish the sign-in/ },
    },
    {
      name: 'ten minutes pass without it ending, as when it waits on input it never gets',
      end: (_proc, clock) => {
        clock.advance(LOGIN_MS);
      },
      outcome: { ok: false, message: /took too long/ },
    },
  ])('ends when $name', async ({ end, outcome }) => {
    const proc = fakeProcess('SIGTERM');
    const clock = new ManualClock();
    const started = await login(proc, clock);
    end(proc, clock);
    const result = await started.outcome;
    if (outcome.ok) expect(result).toEqual({ ok: true });
    else {
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.message).toMatch(outcome.message);
    }
    expect(proc.ended()).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('stops the process on cancel, settles once it has exited, and ignores its exit afterwards', async () => {
    const proc = fakeProcess('SIGTERM');
    const clock = new ManualClock();
    const started = await login(proc, clock);
    await started.cancel();
    expect(proc.ended()).toBe(true);
    proc.exit(0);
    await expect(started.outcome).resolves.toEqual({
      ok: false,
      message: 'The sign-in was cancelled.',
    });
    expect(clock.pendingTimers()).toBe(0);
  });

  it('settles only once the process has exited, so the account directory is free', async () => {
    const proc = fakeProcess();
    const started = await login(proc);
    let settled = false;
    void started.outcome.then(() => {
      settled = true;
    });
    void started.cancel();
    await flush();
    expect(proc.signals()).toEqual(['SIGTERM']);
    expect(settled).toBe(false);
    proc.exit(143);
    await expect(started.outcome).resolves.toMatchObject({ ok: false });
  });

  it('kills a process that ignores the stop with SIGKILL after the grace period, then settles', async () => {
    const proc = fakeProcess('SIGKILL');
    const clock = new ManualClock();
    const started = await login(proc, clock);
    void started.cancel();
    await flush();
    expect(proc.ended()).toBe(false);
    clock.advance(STOP_GRACE_MS);
    await started.outcome;
    expect(proc.signals()).toEqual(['SIGTERM', 'SIGKILL']);
    expect(proc.ended()).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('what a Claude sign-in logs', () => {
  it('holds the exit code and nothing the process printed', async () => {
    const logger = capturingLogger();
    const noisy: LoginSpawn = (_file, _args, options) =>
      spawnLogin(
        process.execPath,
        [
          '-e',
          'console.log("visit https://claude.ai/oauth?state=secret for me@example.com"); console.error("me@example.com"); process.exit(3)',
        ],
        options,
      );
    const started = await startClaudeLogin(
      { ...spec, cwd: realpathSync(tmpdir()) },
      {
        claudePath: '/opt/claude',
        spawn: noisy,
        logger,
      },
    );
    const result = await started.outcome;
    expect(result.ok).toBe(false);
    const logged = logger.lines();
    expect(logged.length).toBeGreaterThan(0);
    for (const text of [JSON.stringify(result), ...logged]) {
      expect(text).not.toContain('me@example.com');
      expect(text).not.toContain('secret');
      expect(text).not.toContain('claude.ai');
    }
    expect(logged.join('\n')).toContain('"code":3');
  });
});

describe('spawnLogin', () => {
  const exitOf = (file: string, args: string[], cwd?: string) =>
    new Promise<number | null>((resolve) => {
      spawnLogin(file, args, { env: {}, cwd: cwd ?? process.cwd() }).onExit(resolve);
    });

  it.each([
    { name: 'a process that exits 0', file: process.execPath, args: ['-e', ''], code: 0 },
    {
      name: 'a process that exits 3 after printing',
      file: process.execPath,
      args: ['-e', 'console.log("x".repeat(200000)); process.exit(3)'],
      code: 3,
    },
    { name: 'a program that does not exist', file: '/nonexistent/claude', args: [], code: null },
  ])('reports $name as its exit code', async ({ file, args, code }) => {
    await expect(exitOf(file, args)).resolves.toBe(code);
  });

  it('runs the process in the directory it is given', async () => {
    const here = realpathSync(tmpdir());
    await expect(
      exitOf(
        process.execPath,
        ['-e', `process.exit(process.cwd() === ${JSON.stringify(here)} ? 0 : 5)`],
        here,
      ),
    ).resolves.toBe(0);
  });
});
