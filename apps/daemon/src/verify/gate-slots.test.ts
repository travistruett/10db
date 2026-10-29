import { describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { createGateSlots, limitGates } from './gate-slots';
import type { GateRequest, GateResult, GateRunner } from './gate-runner';

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

  it('starts the timeout when the gate starts, not when it began waiting', async () => {
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
    // The runner times a gate from the moment it is called, so it must get the whole budget.
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

  it('starts a fresh limiter with every slot free', () => {
    // A restart loses the in-memory slots and the gates that held them; none is owed.
    expect(createGateSlots(1).busy).toBe(0);
  });
});
