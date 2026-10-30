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

  it('runs beforeStart first, and starts nothing when it answers false', async () => {
    const ran = join(dir.path, 'ran');
    const order: string[] = [];
    const started = await runner.run(
      request({
        command: `echo gate >> '${ran}'`,
        beforeStart: () => {
          order.push(existsSync(ran) ? 'after the command' : 'before the command');
          return Promise.resolve(true);
        },
      }),
    );
    expect(started).toMatchObject({ exitCode: 0, aborted: false });
    expect(order).toEqual(['before the command']);
    const stopped = await runner.run(
      request({ command: `echo gate >> '${ran}'`, beforeStart: () => Promise.resolve(false) }),
    );
    expect(stopped).toMatchObject({ aborted: true, timedOut: false });
    expect(readFileSync(ran, 'utf8')).toBe('gate\n');
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
function recordingSandbox(
  options: { refuse?: Error; dockerRefused?: boolean; commandLines?: number } = {},
): {
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
        commandLines: options.commandLines ?? 1,
        dockerRefused: () => options.dockerRefused ?? false,
        dispose: () => {
          disposed += 1;
          return Promise.resolve();
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

  it('asks the sandbox for a package install only when the request is one', async () => {
    const { sandbox, inputs } = recordingSandbox();
    const gate = createGateRunner({ sandbox, logger: silentLogger });
    await gate.run(request({ command: 'true' }));
    await gate.run({ ...request({ command: 'true' }), packageInstall: true });
    expect(inputs.map((input) => input.packageInstall)).toEqual([undefined, true]);
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

  describe('a host the sandbox blocked', () => {
    // What srt's proxy says on its stderr, with SRT_DEBUG set, when it refuses a host.
    const DEBUG_OUTPUT = [
      '[SandboxDebug] Initializing sandbox...',
      '[SandboxDebug] {',
      '  "allowedDomains": ["registry.npmjs.org"]',
      '}',
      '[SandboxDebug] Command string mode (-c): FAKE_SECRET=hunter2 /bin/sh -c cargo build',
      '[SandboxDebug] Connection blocked to Index.Crates.io:443',
      'error: failed to download',
      '[SandboxDebug] Connection blocked to static.crates.io:443',
      '[SandboxDebug] Connection blocked to index.crates.io:443',
    ];
    const printing = (lines: readonly string[]) =>
      `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')} >&2; exit 101`;

    it('names each blocked host once and says the gate was blocked, without the debug lines', async () => {
      const { sandbox } = recordingSandbox();
      const gate = createGateRunner({ sandbox, logger: silentLogger });
      const result = await gate.run(request({ command: printing(DEBUG_OUTPUT) }));
      expect(result.exitCode).toBe(101);
      expect(result.blockedHosts).toEqual(['index.crates.io', 'static.crates.io']);
      expect(result.tail).toContain('error: failed to download');
      expect(result.tail).toContain(
        'The gate was blocked from reaching index.crates.io and static.crates.io',
      );
      for (const text of [result.tail, readFileSync(result.logPath, 'utf8')]) {
        expect(text).not.toContain('SandboxDebug');
        expect(text).not.toContain('hunter2');
        expect(text).not.toContain('allowedDomains');
      }
    });

    it('says the install was blocked, not the gate, when the run is a package install', async () => {
      const { sandbox } = recordingSandbox();
      const gate = createGateRunner({ sandbox, logger: silentLogger });
      const result = await gate.run({
        ...request({
          command: printing([
            '[SandboxDebug] Connection blocked to registry.npmjs.org:443',
            'ERR_PNPM_META_FETCH_FAIL',
          ]),
        }),
        packageInstall: true,
      });
      expect(result.blockedHosts).toEqual(['registry.npmjs.org']);
      for (const text of [result.tail, readFileSync(result.logPath, 'utf8')]) {
        expect(text).toContain('The install was blocked from reaching registry.npmjs.org');
        expect(text).not.toMatch(/\bgate\b/i);
      }
    });

    it('names a host srt refused a plain HTTP request to', async () => {
      const { sandbox } = recordingSandbox();
      const gate = createGateRunner({ sandbox, logger: silentLogger });
      const result = await gate.run(
        request({
          command: printing([
            '[SandboxDebug] HTTP request blocked to example.com:80',
            'curl: (22) The requested URL returned error: 403',
          ]),
        }),
      );
      expect(result.blockedHosts).toEqual(['example.com']);
      expect(result.tail).toContain('curl: (22) The requested URL returned error: 403');
      expect(result.tail).toContain('The gate was blocked from reaching example.com');
      expect(result.tail).not.toContain('SandboxDebug');
    });

    it('drops every line of a command line srt echoes, as many as the sandbox says it takes', async () => {
      const { sandbox } = recordingSandbox({ commandLines: 2 });
      const gate = createGateRunner({ sandbox, logger: silentLogger });
      const result = await gate.run(
        request({
          command: printing([
            "[SandboxDebug] Command string mode (-c): /usr/bin/env TOKEN='one",
            "  hunter2' /bin/sh -c 'cargo test'",
            '  indented output of the command',
          ]),
        }),
      );
      expect(result.tail).not.toContain('hunter2');
      expect(result.tail).toContain('  indented output of the command');
    });

    it('reports no blocked host for a gate nothing blocked', async () => {
      const { sandbox } = recordingSandbox();
      const gate = createGateRunner({ sandbox, logger: silentLogger });
      const result = await gate.run(request({ command: 'echo fine' }));
      expect(result.blockedHosts).toEqual([]);
      expect(result.tail).not.toContain('blocked');
    });

    it('leaves a gate with no sandbox alone', async () => {
      const result = await run(printing(DEBUG_OUTPUT));
      expect(result.blockedHosts).toEqual([]);
      expect(result.tail).toContain('SandboxDebug');
    });

    it('reads a line split across chunks', async () => {
      const { sandbox } = recordingSandbox();
      const gate = createGateRunner({ sandbox, logger: silentLogger });
      const result = await gate.run(
        request({
          command:
            "printf '[SandboxDebug] Connection blo' >&2; sleep 0.2; printf 'cked to a.example.com:443\\n' >&2; exit 1",
        }),
      );
      expect(result.blockedHosts).toEqual(['a.example.com']);
    });
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
