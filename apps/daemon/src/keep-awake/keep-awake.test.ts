import { KeepAwakeMode } from '@10db/contracts';
import { createTestStore } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import {
  createKeepAwake,
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

describe('keep-awake', () => {
  it('defaults to while_running and holds nothing while no lane runs', () => {
    keepAwake.refresh();
    expect(keepAwake.status()).toEqual({ mode: KeepAwakeMode.WhileRunning, active: false });
    expect(fake.procs).toEqual([]);
  });
});
