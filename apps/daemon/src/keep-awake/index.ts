import { spawn } from 'node:child_process';
import { EventType, KeepAwakeMode, type KeepAwakeStatus } from '@10db/contracts';
import { countLanes, getAppSetting, setAppSetting } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import type { Logger } from '../log';

export const KEEP_AWAKE_SETTING = 'keep_awake';
const DEFAULT_KEEP_AWAKE: KeepAwakeMode = KeepAwakeMode.WhileRunning;

export interface CaffeinateProcess {
  stop(): void;
  /** Settles when the process has exited, for any reason. */
  readonly exited: Promise<void>;
}

/** Returns null where caffeinate doesn't exist; keep-awake then holds nothing and says so. */
export type CaffeinateSpawner = (daemonPid: number) => CaffeinateProcess | null;

/**
 * `caffeinate -i` prevents idle sleep; `-w <pid>` makes it exit when the daemon exits, even on
 * `kill -9`. caffeinate exists only on macOS; elsewhere (CI) keep-awake holds nothing.
 */
export const systemCaffeinate: CaffeinateSpawner = (daemonPid) => {
  if (process.platform !== 'darwin') return null;
  const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(daemonPid)], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    child.once('error', () => {
      resolve();
    });
  });
  return {
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    },
    exited,
  };
};

export interface KeepAwake {
  status(): KeepAwakeStatus;
  setMode(mode: KeepAwakeMode): KeepAwakeStatus;
  /** Starts or stops caffeinate to match the mode and the running lanes. */
  refresh(): void;
  stop(): void;
}

const StoredMode = z.enum(KeepAwakeMode);

export function createKeepAwake(deps: {
  readonly state: StateStore;
  readonly spawn: CaffeinateSpawner;
  readonly daemonPid: number;
  readonly logger: Logger;
}): KeepAwake {
  let held: CaffeinateProcess | null = null;
  let stopped = false;

  const mode = (): KeepAwakeMode => {
    const parsed = StoredMode.safeParse(getAppSetting(deps.state.db, KEEP_AWAKE_SETTING));
    return parsed.success ? parsed.data : DEFAULT_KEEP_AWAKE;
  };

  const wanted = (): boolean => {
    const current = mode();
    if (current === KeepAwakeMode.Always) return true;
    return current === KeepAwakeMode.WhileRunning && countLanes(deps.state.db).global > 0;
  };

  const release = (): void => {
    held?.stop();
    held = null;
  };

  const hold = (): void => {
    const proc = deps.spawn(deps.daemonPid);
    if (!proc) return;
    held = proc;
    void proc.exited.then(() => {
      if (held === proc) {
        held = null;
        if (!stopped)
          deps.logger.warn({}, 'caffeinate exited; it restarts on the next lane change');
      }
    });
  };

  const refresh = (): void => {
    if (stopped) return;
    if (wanted()) {
      if (!held) hold();
    } else release();
  };

  return {
    status: () => ({ mode: mode(), active: held !== null }),
    setMode(next) {
      deps.state.write((ctx) => {
        setAppSetting(ctx, KEEP_AWAKE_SETTING, next);
        ctx.emit({
          type: EventType.SettingsChanged,
          entityType: 'app_setting',
          entityId: KEEP_AWAKE_SETTING,
          data: { mode: next },
        });
      });
      refresh();
      return { mode: mode(), active: held !== null };
    },
    refresh,
    stop() {
      stopped = true;
      release();
    },
  };
}
