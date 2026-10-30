import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { createGateSlots, GateSlotLimitError, limitGates } from './gate-slots';
import {
  createGateRunner,
  type GateRequest,
  type GateResult,
  type GateRunner,
} from './gate-runner';

function request(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    project: { repoPath: '/repo', sandboxLoopback: false },
    command: 'make gate',
    logPath: '/logs/gate.log',
    timeoutMs: 1_000,
    env: {},
    rules: [],
    checkouts: ['/repo'],
    ...overrides,
  };
}

function result(overrides: Partial<GateResult> = {}): GateResult {
  return {
    exitCode: 0,
    durationMs: 1,
    tail: '',
    logPath: '/logs/gate.log',
    timedOut: false,
    aborted: false,
    blockedHosts: [],
    ...overrides,
  };
}

/** A runner whose gates finish when the test says so; `started` lists the commands that have begun. */
function controlledRunner() {
  const started: GateRequest[] = [];
  const finish: ((outcome: GateResult | Error) => void)[] = [];
  const runner: GateRunner = {
    run: (req) =>
      new Promise<GateResult>((resolve, reject) => {
        started.push(req);
        finish.push((outcome) => {
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        });
      }),
  };
  return { runner, started, finish };
}

/** Lets pending promise callbacks run; the limiter has no timers, so this is all a wait needs. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function limited(limit: number, runner: GateRunner, clock = new ManualClock()) {
  const slots = createGateSlots(limit);
  return { slots, gate: limitGates(runner, { slots, clock, logger: silentLogger }), clock };
}

describe('gate slots', () => {
  it('holds the second gate until the first finishes, then runs it', async () => {
    const { runner, started, finish } = controlledRunner();
    const { gate } = limited(1, runner);
    const first = gate.run(request({ command: 'first' }));
    const second = gate.run(request({ command: 'second' }));
    await settle();
    expect(started.map((r) => r.command)).toEqual(['first']);
    finish[0]?.(result());
    await first;
    await settle();
    expect(started.map((r) => r.command)).toEqual(['first', 'second']);
    finish[1]?.(result());
    expect((await second).exitCode).toBe(0);
  });

  it('lets two gates run at once when the limit is 2, and holds the third', async () => {
    const { runner, started, finish } = controlledRunner();
    const { gate } = limited(2, runner);
    const runs = ['a', 'b', 'c'].map((command) => gate.run(request({ command })));
    await settle();
    expect(started.map((r) => r.command)).toEqual(['a', 'b']);
    finish[0]?.(result());
    await settle();
    expect(started.map((r) => r.command)).toEqual(['a', 'b', 'c']);
    finish[1]?.(result());
    finish[2]?.(result());
    await Promise.all(runs);
  });

  it('serves waiting gates in the order they asked', async () => {
    const { runner, started, finish } = controlledRunner();
    const { gate } = limited(1, runner);
    const runs = ['a', 'b', 'c', 'd'].map((command) => gate.run(request({ command })));
    for (let i = 0; i < 4; i++) {
      await settle();
      finish[i]?.(result());
    }
    await Promise.all(runs);
    expect(started.map((r) => r.command)).toEqual(['a', 'b', 'c', 'd']);
  });

  describe('the slot is freed on every exit path', () => {
    const outcomes: readonly [string, GateResult | Error][] = [
      ['a pass', result()],
      ['a failure', result({ exitCode: 1 })],
      ['a timeout', result({ exitCode: 124, timedOut: true })],
      ['an abort', result({ exitCode: 130, aborted: true })],
      ['a throw', new Error('spawn failed')],
    ];
    it.each(outcomes)('after %s', async (_name, outcome) => {
      const { runner, started, finish } = controlledRunner();
      const { gate, slots } = limited(1, runner);
      const first = gate.run(request({ command: 'first' })).catch((error: unknown) => error);
      const second = gate.run(request({ command: 'second' }));
      await settle();
      finish[0]?.(outcome);
      await first;
      await settle();
      expect(started.map((r) => r.command)).toEqual(['first', 'second']);
      finish[1]?.(result());
      await second;
      expect(slots.busy).toBe(0);
    });
  });

  it('frees the slot when the runner throws before it returns a promise', async () => {
    const slots = createGateSlots(1);
    const gate = limitGates(
      {
        run: () => {
          throw new Error('sync throw');
        },
      },
      { slots, clock: new ManualClock(), logger: silentLogger },
    );
    await expect(gate.run(request())).rejects.toThrow('sync throw');
    expect(slots.busy).toBe(0);
  });

  describe('an abort while waiting', () => {
    it('releases the waiter without running its gate, and leaves the queue intact', async () => {
      const { runner, started, finish } = controlledRunner();
      const { gate, slots } = limited(1, runner);
      const first = gate.run(request({ command: 'first' }));
      const controller = new AbortController();
      const aborted = gate.run(request({ command: 'aborted', signal: controller.signal }));
      const third = gate.run(request({ command: 'third' }));
      await settle();
      expect(slots.waiting).toBe(2);
      controller.abort();
      const outcome = await aborted;
      expect(outcome).toMatchObject({ aborted: true, timedOut: false, exitCode: 130 });
      expect(slots.waiting).toBe(1);
      finish[0]?.(result());
      await first;
      await settle();
      expect(started.map((r) => r.command)).toEqual(['first', 'third']);
      finish[1]?.(result());
      await third;
      expect(slots.busy).toBe(0);
    });

    it('answers a signal that was already aborted without waiting', async () => {
      const { runner, started } = controlledRunner();
      const { gate, slots } = limited(1, runner);
      const controller = new AbortController();
      controller.abort();
      const outcome = await gate.run(request({ signal: controller.signal }));
      expect(outcome.aborted).toBe(true);
      expect(started).toHaveLength(0);
      expect(slots.busy).toBe(0);
    });
  });

  describe('while the Mac is overloaded', () => {
    /** A hold the test opens and closes, as the load guard does. */
    function fakeHold() {
      let open: () => void = () => undefined;
      let overloaded = true;
      const asked: (AbortSignal | undefined)[] = [];
      return {
        asked,
        release: () => {
          overloaded = false;
          open();
        },
        hold: {
          untilClear: (signal?: AbortSignal) => {
            asked.push(signal);
            if (!overloaded) return Promise.resolve(true);
            return new Promise<boolean>((resolve) => {
              open = () => {
                resolve(true);
              };
              signal?.addEventListener('abort', () => {
                resolve(false);
              });
            });
          },
        },
      };
    }

    it('starts no gate until the load falls, then starts it', async () => {
      const { runner, started, finish } = controlledRunner();
      const slots = createGateSlots(2);
      const fake = fakeHold();
      const gate = limitGates(runner, {
        slots,
        clock: new ManualClock(),
        logger: silentLogger,
        hold: fake.hold,
      });
      const run = gate.run(request({ command: 'held' }));
      await settle();
      expect(started).toEqual([]);
      expect(slots.busy).toBe(0);
      fake.release();
      await settle();
      expect(started.map((r) => r.command)).toEqual(['held']);
      finish[0]?.(result());
      expect((await run).exitCode).toBe(0);
    });

    it('stops a held gate that is aborted, without ever running it', async () => {
      const { runner, started } = controlledRunner();
      const fake = fakeHold();
      const gate = limitGates(runner, {
        slots: createGateSlots(1),
        clock: new ManualClock(),
        logger: silentLogger,
        hold: fake.hold,
      });
      const controller = new AbortController();
      const run = gate.run(request({ signal: controller.signal }));
      await settle();
      controller.abort();
      expect(await run).toMatchObject({ aborted: true, exitCode: 130, timedOut: false });
      expect(started).toEqual([]);
    });
  });

  it('hands the runner the whole timeout once the slot is held, so the wait is not spent', async () => {
    const { runner, started, finish } = controlledRunner();
    const clock = new ManualClock();
    const { gate } = limited(1, runner, clock);
    const first = gate.run(request({ command: 'first' }));
    const second = gate.run(request({ command: 'second', timeoutMs: 1_000 }));
    await settle();
    clock.advance(60 * 60_000);
    finish[0]?.(result());
    await first;
    await settle();
    // The runner times a gate from the moment it is called, after the slot is held.
    expect(started[1]?.timeoutMs).toBe(1_000);
    finish[1]?.(result());
    expect((await second).timedOut).toBe(false);
  });

  it('tells a gate how many are ahead of it when it has to wait, and not when it does not', async () => {
    const { runner, finish } = controlledRunner();
    const { gate } = limited(1, runner);
    const calls: [string, number][] = [];
    const ask = (command: string) =>
      gate.run(request({ command, onWaiting: (ahead) => calls.push([command, ahead]) }));
    const runs = [ask('a'), ask('b'), ask('c')];
    await settle();
    expect(calls).toEqual([
      ['b', 1],
      ['c', 2],
    ]);
    for (let i = 0; i < 3; i++) {
      await settle();
      finish[i]?.(result());
    }
    await Promise.all(runs);
  });

  it('shares one limit between a verify gate and a ship gate', async () => {
    const { runner, started, finish } = controlledRunner();
    const { gate } = limited(1, runner);
    // The same wrapped runner is what the runner and the shipper are each given.
    const verify = gate.run(request({ command: 'verify', logPath: '/logs/ws-1.log' }));
    const ship = gate.run(request({ command: 'ship', logPath: '/logs/batch-1.log' }));
    await settle();
    expect(started.map((r) => r.command)).toEqual(['verify']);
    finish[0]?.(result());
    await verify;
    await settle();
    expect(started.map((r) => r.command)).toEqual(['verify', 'ship']);
    finish[1]?.(result());
    await ship;
  });

  it('answers every waiter and later caller with an abort once closed', async () => {
    const { runner, started, finish } = controlledRunner();
    const { gate, slots } = limited(1, runner);
    const first = gate.run(request({ command: 'first' }));
    const waiting = gate.run(request({ command: 'waiting' }));
    await settle();
    slots.close();
    expect((await waiting).aborted).toBe(true);
    finish[0]?.(result());
    await first;
    expect((await gate.run(request({ command: 'late' }))).aborted).toBe(true);
    expect(started.map((r) => r.command)).toEqual(['first']);
    expect(slots.busy).toBe(0);
  });

  it("runs a gate's beforeStart only once it holds its slot, after the gate ahead has finished", async () => {
    const dir = tempDir('gate-slot-order');
    try {
      const { gate } = limited(1, createGateRunner({ sandbox: null, logger: silentLogger }));
      const firstDone = join(dir.path, 'first-done');
      let releaseFirst: () => void = () => undefined;
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const seen: string[] = [];
      const gateRequest = (name: string, command: string, before: () => Promise<boolean>) =>
        request({
          project: { repoPath: dir.path, sandboxLoopback: false },
          command,
          logPath: join(dir.path, `${name}.log`),
          env: { PATH: '/usr/bin:/bin' },
          checkouts: [dir.path],
          beforeStart: before,
        });
      const first = gate.run(
        gateRequest('first', `touch '${firstDone}'`, async () => {
          seen.push('first before');
          await firstHeld;
          return true;
        }),
      );
      const second = gate.run(
        gateRequest('second', 'true', () => {
          seen.push(
            existsSync(firstDone) ? 'second before, first finished' : 'second before, first not',
          );
          return Promise.resolve(true);
        }),
      );
      await settle();
      expect(seen).toEqual(['first before']);
      releaseFirst();
      expect((await first).exitCode).toBe(0);
      expect((await second).exitCode).toBe(0);
      expect(seen).toEqual(['first before', 'second before, first finished']);
    } finally {
      dir.cleanup();
    }
  });

  it.each([[0], [-1], [1.5], [Number.NaN]])('refuses a limit of %s', (limit) => {
    expect(() => createGateSlots(limit)).toThrow(GateSlotLimitError);
  });
});
