import { existsSync, fstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { silentLogger } from '../log';
import {
  DOCKER_REFUSAL,
  SandboxProfileError,
  type GateRun,
  type GateRunInput,
  type GateSandbox,
} from '../sandbox';
import { createGateRunner, type GateRequest } from './index';

/** The test process's own env, as the strings a gate takes. */
const env = Object.fromEntries(
  Object.entries(process.env).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, value]],
  ),
);
// These cases are about the process group and the log, so they run the command with no sandbox.
const runner = createGateRunner({ sandbox: null, logger: silentLogger });
let dir: { path: string; cleanup(): void };
beforeEach(() => {
  dir = tempDir('gate');
});
afterEach(() => {
  dir.cleanup();
});

function request(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    project: { repoPath: dir.path, sandboxLoopback: false },
    command: 'true',
    logPath: join(dir.path, 'logs', 'gate.log'),
    timeoutMs: 10_000,
    env,
    rules: [],
    checkouts: [dir.path],
    ...overrides,
  };
}

const run = (command: string, timeoutMs = 10_000) => runner.run(request({ command, timeoutMs }));

const DEADLINE_MS = 10_000;

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const isGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

async function readPid(): Promise<number> {
  const file = join(dir.path, 'grandchild.pid');
  await waitUntil(
    () => existsSync(file) && readFileSync(file, 'utf8').endsWith('\n'),
    'grandchild pid',
  );
  return Number(readFileSync(file, 'utf8'));
}

const expectGone = (pid: number): Promise<void> =>
  waitUntil(() => isGone(pid), `pid ${String(pid)} to exit`);

describe('gate runner', () => {
  it('records a passing gate with its output in the log and the tail', async () => {
    const result = await run('echo checks-ok');
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.tail).toContain('checks-ok');
    expect(readFileSync(result.logPath, 'utf8')).toContain('checks-ok');
  });

  it('records the exit code of a failing gate and stderr', async () => {
    const result = await run('echo broken >&2; exit 3');
    expect(result.exitCode).toBe(3);
    expect(result.tail).toContain('broken');
  });

  it('kills the whole process group on timeout', async () => {
    const result = await run(`sh -c 'sleep 30' & echo $! > grandchild.pid; wait`, 1_000);
    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    expect(result.durationMs).toBeLessThan(5_000);
    await expectGone(await readPid());
  });

  it('kills what the gate left running in its group before it gives the verdict', async () => {
    const result = await run(`sleep 30 >/dev/null 2>&1 & echo $! > grandchild.pid`);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    await expectGone(await readPid());
  });

  it.each([
    ['TERM', 'kill -TERM $$'],
    ['INT', 'kill -INT $$'],
    ['KILL', 'kill -KILL $$'],
  ])('fails a gate that dies by SIG%s', async (_signal, command) => {
    const result = await run(`echo partial; ${command}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.tail).toContain('partial');
  });

  it('kills the process group when aborted, and reports the spawned pid', async () => {
    const abort = new AbortController();
    const pids: number[] = [];
    const pending = runner.run({
      ...request({ command: `sh -c 'sleep 30' & echo $! > grandchild.pid; wait` }),
      signal: abort.signal,
      onSpawn: (pid) => {
        pids.push(pid);
      },
    });
    const grandchild = await readPid();
    abort.abort();
    const result = await pending;
    expect(result).toMatchObject({ exitCode: 130, aborted: true, timedOut: false });
    expect(result.durationMs).toBeLessThan(5_000);
    expect(pids).toHaveLength(1);
    await expectGone(grandchild);
  });

  it('rejects and kills the group when onSpawn throws', async () => {
    let leader = 0;
    await expect(
      runner.run({
        ...request({ command: 'sleep 30' }),
        onSpawn: (pid) => {
          leader = pid;
          throw new Error('stale fence');
        },
      }),
    ).rejects.toThrow('stale fence');
    await expectGone(leader);
  });

  it('closes its log when onSpawn throws, so nothing writes into the log dir afterwards', async () => {
    const logPath = join(dir.path, 'logs', 'gate.log');
    // The descriptors that point at gate.log, found by identity so the count does not depend on GC.
    const openLogHandles = (): number => {
      const log = statSync(logPath);
      return readdirSync('/dev/fd').filter((name) => {
        try {
          const handle = fstatSync(Number(name));
          return handle.ino === log.ino && handle.dev === log.dev;
        } catch {
          return false;
        }
      }).length;
    };
    await expect(
      runner.run({
        ...request({ command: 'sleep 30', logPath }),
        onSpawn: () => {
          throw new Error('stale fence');
        },
      }),
    ).rejects.toThrow('stale fence');
    // The log opens asynchronously; by the time the run rejects it must have opened and finished, so a
    // caller that removes the log dir next races no late open.
    expect(existsSync(logPath)).toBe(true);
    await waitUntil(() => openLogHandles() === 0, 'the gate log to close');
  });

  it('still runs the gate when the log cannot be written', async () => {
    const result = await runner.run(request({ command: 'echo still-runs', logPath: dir.path }));
    expect(result.exitCode).toBe(0);
    expect(result.tail).toContain('still-runs');
  });

  it('keeps only the end of very long output in the tail', async () => {
    const result = await run(`yes line | head -n 5000; echo LAST-LINE`);
    expect(result.tail.length).toBeLessThanOrEqual(4096);
    expect(result.tail).toContain('LAST-LINE');
  });
});

/** A stand-in for the gate sandbox: its runs wrap the command so the output shows they were used. */
function recordingSandbox(options: { refuse?: Error; dockerRefused?: boolean } = {}): {
  sandbox: GateSandbox;
  inputs: GateRunInput[];
  disposed: () => number;
} {
  const inputs: GateRunInput[] = [];
  let disposed = 0;
  const sandbox: GateSandbox = {
    forRun(input) {
      inputs.push(input);
      if (options.refuse) return Promise.reject(options.refuse);
      const run: GateRun = {
        file: '/bin/sh',
        args: ['-c', `echo in-the-sandbox; ${input.command}`],
        env: { PATH: '/usr/bin:/bin' },
        cwd: input.project.repoPath,
        tmpDir: input.project.repoPath,
        commandEnv: {},
        dockerRefused: () => options.dockerRefused ?? false,
        dispose: () => {
          disposed += 1;
        },
      };
      return Promise.resolve(run);
    },
  };
  return { sandbox, inputs, disposed: () => disposed };
}

describe('gate runner with a sandbox', () => {
  it('needs a sandbox, or an explicit null', () => {
    // @ts-expect-error a gate runner takes its sandbox, or null, explicitly
    createGateRunner({ logger: silentLogger });
  });

  it('runs every gate through the sandbox, and disposes of it once the gate exits', async () => {
    const { sandbox, inputs, disposed } = recordingSandbox();
    const gate = createGateRunner({ sandbox, logger: silentLogger });
    const rules = [{ toolName: 'SandboxNetworkAccess', pattern: 'registry.npmjs.org' }];
    const result = await gate.run(
      request({ command: 'echo checks-ok', env: { PATH: '/bin', GH_TOKEN: 'x' }, rules }),
    );
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.tail).toContain('in-the-sandbox');
    expect(result.tail).toContain('checks-ok');
    expect(inputs).toEqual([
      {
        project: { repoPath: dir.path, sandboxLoopback: false },
        env: { PATH: '/bin', GH_TOKEN: 'x' },
        rules,
        checkouts: [dir.path],
        command: 'echo checks-ok',
      },
    ]);
    expect(disposed()).toBe(1);
  });

  it('fails the gate, saying why, when its sandbox is refused; nothing runs', async () => {
    const { sandbox } = recordingSandbox({
      refuse: new SandboxProfileError('secretFiles', 'a .env* link leads to /x'),
    });
    const gate = createGateRunner({ sandbox, logger: silentLogger });
    const spawned: number[] = [];
    const result = await gate.run({
      ...request({ command: 'touch ran' }),
      onSpawn: (pid) => spawned.push(pid),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.tail).toContain(
      "10db could not start the gate's sandbox: a .env* link leads to /x",
    );
    expect(readFileSync(result.logPath, 'utf8')).toContain('a .env* link leads to /x');
    expect(spawned).toEqual([]);
    expect(existsSync(join(dir.path, 'ran'))).toBe(false);
  });

  it('passes on an error that is no refusal', async () => {
    const { sandbox } = recordingSandbox({ refuse: new Error('disk on fire') });
    const gate = createGateRunner({ sandbox, logger: silentLogger });
    await expect(gate.run(request())).rejects.toThrow('disk on fire');
  });

  it('says in the evidence when the gate tried to use Docker', async () => {
    const { sandbox } = recordingSandbox({ dockerRefused: true });
    const gate = createGateRunner({ sandbox, logger: silentLogger });
    const result = await gate.run(request({ command: 'echo lots of output; exit 1' }));
    expect(result.exitCode).toBe(1);
    expect(result.tail.trimEnd().endsWith(DOCKER_REFUSAL)).toBe(true);
    expect(readFileSync(result.logPath, 'utf8')).toContain(DOCKER_REFUSAL);
  });
});
