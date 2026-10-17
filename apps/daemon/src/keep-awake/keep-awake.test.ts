import { EventType, KeepAwakeMode, WorkstreamState } from '@10db/contracts';
import { createTestStore, listEventsAfter, setAppSetting, transitionWorkstream } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { spawn } from 'node:child_process';
import {
  createKeepAwake,
  KEEP_AWAKE_SETTING,
  systemCaffeinate,
  type CaffeinateProcess,
  type CaffeinateSpawner,
  type KeepAwake,
} from './index';

interface FakeCaffeinate {
  readonly pid: number;
  stopped: boolean;
  exit(): void;
}

function fakeSpawner(): { spawn: CaffeinateSpawner; procs: FakeCaffeinate[] } {
  const procs: FakeCaffeinate[] = [];
  const spawn: CaffeinateSpawner = (pid): CaffeinateProcess => {
    let resolveExit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const proc: FakeCaffeinate = {
      pid,
      stopped: false,
      exit: () => {
        resolveExit();
      },
    };
    procs.push(proc);
    return {
      stop() {
        proc.stopped = true;
        resolveExit();
      },
      exited,
    };
  };
  return { spawn, procs };
}

const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const DAEMON_PID = 4242;

let close: () => void;
let base: ReturnType<typeof createTestStore>['store'];
let state: StateStore;
let fake: ReturnType<typeof fakeSpawner>;
let keepAwake: KeepAwake;

beforeEach(() => {
  ({ store: base, close } = createTestStore());
  state = createStateStore(base, createEventBus());
  fake = fakeSpawner();
  keepAwake = createKeepAwake({
    state,
    spawn: fake.spawn,
    daemonPid: DAEMON_PID,
    logger: silentLogger,
  });
});
afterEach(() => {
  keepAwake.stop();
  close();
});

function startLane() {
  const { workstream } = seedWorkstream(base);
  state.write((ctx) =>
    transitionWorkstream(ctx, workstream.id, { to: WorkstreamState.Starting, fence: null }),
  );
  return workstream;
}

describe('keep-awake', () => {
  it('defaults to while_running and holds nothing while no lane runs', () => {
    keepAwake.refresh();
    expect(keepAwake.status()).toEqual({ mode: KeepAwakeMode.WhileRunning, active: false });
    expect(fake.procs).toEqual([]);
  });

  it('holds caffeinate on the daemon pid while a lane runs, and releases it when lanes free', () => {
    const ws = startLane();
    keepAwake.refresh();
    expect(keepAwake.status().active).toBe(true);
    expect(fake.procs.map((p) => p.pid)).toEqual([DAEMON_PID]);

    keepAwake.refresh();
    expect(fake.procs).toHaveLength(1);

    state.write((ctx) =>
      transitionWorkstream(ctx, ws.id, { to: WorkstreamState.Cancelled, fence: null }),
    );
    keepAwake.refresh();
    expect(keepAwake.status().active).toBe(false);
    expect(fake.procs[0]?.stopped).toBe(true);
  });

  it('always holds in always mode and never in off mode, and persists the mode with an event', () => {
    expect(keepAwake.setMode(KeepAwakeMode.Always)).toEqual({
      mode: KeepAwakeMode.Always,
      active: true,
    });
    expect(keepAwake.setMode(KeepAwakeMode.Off)).toEqual({
      mode: KeepAwakeMode.Off,
      active: false,
    });
    startLane();
    keepAwake.refresh();
    expect(keepAwake.status().active).toBe(false);

    const reloaded = createKeepAwake({
      state,
      spawn: fake.spawn,
      daemonPid: DAEMON_PID,
      logger: silentLogger,
    });
    expect(reloaded.status().mode).toBe(KeepAwakeMode.Off);
    const changes = listEventsAfter(base.db, 0, 100).filter(
      (e) => e.type === EventType.SettingsChanged,
    );
    expect(changes.map((e) => [e.entityId, e.data['mode']])).toEqual([
      [KEEP_AWAKE_SETTING, 'always'],
      [KEEP_AWAKE_SETTING, 'off'],
    ]);
  });

  it('starts caffeinate again when it exits while still wanted', async () => {
    keepAwake.setMode(KeepAwakeMode.Always);
    fake.procs[0]?.exit();
    await tick();
    expect(keepAwake.status().active).toBe(false);
    keepAwake.refresh();
    expect(fake.procs).toHaveLength(2);
    expect(keepAwake.status().active).toBe(true);
  });

  it('falls back to the default for an unreadable stored mode', () => {
    state.write((ctx) => {
      setAppSetting(ctx, KEEP_AWAKE_SETTING, 'sometimes');
    });
    expect(keepAwake.status().mode).toBe(KeepAwakeMode.WhileRunning);
  });

  it('reports inactive, without retrying in a loop, when caffeinate is unavailable', () => {
    let attempts = 0;
    const unavailable = createKeepAwake({
      state,
      spawn: () => {
        attempts += 1;
        return null;
      },
      daemonPid: DAEMON_PID,
      logger: silentLogger,
    });
    expect(unavailable.setMode(KeepAwakeMode.Always)).toEqual({
      mode: KeepAwakeMode.Always,
      active: false,
    });
    unavailable.refresh();
    expect(unavailable.status().active).toBe(false);
    // One attempt per refresh, never a respawn loop.
    expect(attempts).toBe(2);
  });

  it('releases caffeinate on stop', () => {
    keepAwake.setMode(KeepAwakeMode.Always);
    keepAwake.stop();
    expect(fake.procs[0]?.stopped).toBe(true);
  });
});

describe('systemCaffeinate', () => {
  it.skipIf(process.platform !== 'darwin')(
    'exits on its own when the watched process dies',
    async () => {
      const watched = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
      const proc = systemCaffeinate(watched.pid ?? 0);
      // systemCaffeinate returns null where caffeinate is missing; on macOS that is a failure.
      if (!proc) throw new Error('caffeinate unavailable');
      watched.kill('SIGKILL');
      await expect(
        Promise.race([
          proc.exited.then(() => 'exited'),
          new Promise((r) =>
            setTimeout(() => {
              r('still running');
            }, 5_000),
          ),
        ]),
      ).resolves.toBe('exited');
    },
  );

  it.skipIf(process.platform === 'darwin')('holds nothing where caffeinate does not exist', () => {
    expect(systemCaffeinate(process.pid)).toBeNull();
  });
});
