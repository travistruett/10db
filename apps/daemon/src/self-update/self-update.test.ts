import type { ProjectId } from '@10db/contracts';
import { createTestStore, getAppSetting, listInbox, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService } from '../inbox';
import { silentLogger, type Logger } from '../log';
import {
  createSelfUpdate,
  SELF_UPDATE_APPLYING_KEY,
  SELF_UPDATE_FAILED_KEY,
  type ApplyResult,
  type ScriptStatus,
  type SelfUpdate,
  type StageResult,
} from './self-update';

const RUNNING = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);
const STAGED = { dir: '/data/self-update/stage', commit: NEW };
const STAGED_OK: StageResult = { ok: true, current: false, ...STAGED };

let close: () => void;
let state: StateStore;
let projectId: ProjectId;
let clock: ManualClock;

/** Everything the update asks of the outside world, scripted per test. */
interface World {
  head: string | Error;
  /** Whether main's head is ahead of the running commit, as GitHub's comparison says. */
  ahead: boolean | Error;
  /** Whether the staged build is ahead of the running commit. */
  stagedAhead: boolean;
  /** The repositories and running commits stage was asked about. */
  stagedFrom: string[];
  stagedFor: string[];
  stage: () => Promise<StageResult>;
  /** Stops a stage under way, as the installer kills the script's process group. */
  stopStage: () => Promise<void>;
  /** Called as the installer's apply is: a throw here is a synchronous throw from apply. */
  apply: () => { readonly ok: true } | Extract<ApplyResult, { ok: false }>;
  busy: number;
  /** What the work count becomes once new work is paused: a lane that started in between. */
  busyAfterPause: number | null;
  /** Settles once the scheduler is stopped and has finished the tick it was in. */
  pause: () => Promise<void>;
  status: ScriptStatus | null;
  /** Ends the detached install script while this daemon is still running. */
  endScript: () => void;
  calls: string[];
}
let world: World;

function make(
  overrides: {
    runningCommit?: string | null;
    enabled?: boolean;
    cardProject?: ProjectId | null;
    headOf?: () => Promise<string>;
    logger?: Logger;
  } = {},
): SelfUpdate {
  return createSelfUpdate({
    state,
    inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
    clock,
    logger: overrides.logger ?? silentLogger,
    runningCommit: overrides.runningCommit === undefined ? RUNNING : overrides.runningCommit,
    intervalMs: 120_000,
    repository: 'o/10db',
    enabled: () => overrides.enabled !== false,
    cardProject: () => (overrides.cardProject === undefined ? projectId : overrides.cardProject),
    headOf:
      overrides.headOf ??
      (() =>
        world.head instanceof Error ? Promise.reject(world.head) : Promise.resolve(world.head)),
    isAhead: (_repo, _base, head) => {
      if (head === world.head) {
        return world.ahead instanceof Error
          ? Promise.reject(world.ahead)
          : Promise.resolve(world.ahead);
      }
      return Promise.resolve(world.stagedAhead);
    },
    stage: (target, running) => {
      world.calls.push('stage');
      world.stagedFrom.push(target.repo);
      world.stagedFor.push(running);
      return world.stage();
    },
    stopStage: () => {
      world.calls.push('stop-stage');
      return world.stopStage();
    },
    apply: () => {
      world.calls.push('apply');
      const result = world.apply();
      if (!result.ok) return Promise.resolve(result);
      const ended = new Promise<void>((resolve) => {
        world.endScript = resolve;
      });
      return Promise.resolve({ ...result, ended });
    },
    midSession: () => world.busy,
    pause: () => {
      world.calls.push('pause');
      if (world.busyAfterPause !== null) world.busy = world.busyAfterPause;
      return world.pause();
    },
    resume: () => {
      world.calls.push('resume');
    },
    outcome: {
      read: () => world.status,
      clear: () => {
        world.status = null;
      },
    },
  });
}

const cards = () =>
  listInbox(state.db, {}).filter((item) => item.title.startsWith('Updating 10db'));
const settled = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  projectId = seedProject(test.store).id;
  clock = new ManualClock();
  world = {
    head: NEW,
    ahead: true,
    stagedAhead: true,
    stagedFrom: [],
    stagedFor: [],
    pause: () => Promise.resolve(),
    stage: () => Promise.resolve(STAGED_OK),
    stopStage: () => Promise.resolve(),
    apply: () => ({ ok: true }),
    busy: 0,
    busyAfterPause: null,
    status: null,
    endScript: () => undefined,
    calls: [],
  };
});
afterEach(() => {
  close();
});

describe('tick', () => {
  it('does nothing in a run from source, which has no commit to compare', async () => {
    const update = make({ runningCommit: null });
    expect(await update.tick()).toBe('disabled');
    expect(world.calls).toEqual([]);
  });

  it('does nothing when the switch is off', async () => {
    const update = make({ enabled: false });
    expect(await update.tick()).toBe('off');
    expect(world.calls).toEqual([]);
  });

  it('stages from the repository the app was built for, and no other', async () => {
    await make().tick();
    expect(world.stagedFrom).toEqual(['o/10db']);
    expect(world.stagedFor).toEqual([RUNNING]);
  });

  it('does nothing when main is not ahead of the running commit: a build from another branch stays', async () => {
    world.ahead = false;
    const update = make();
    expect(await update.tick()).toBe('not-ahead');
    expect(update.status().availableCommit).toBeNull();
    expect(world.calls).toEqual([]);
  });

  it('says once in the log, for each head of main, why it leaves a build main is not ahead of', async () => {
    world.ahead = false;
    const said: string[] = [];
    const update = make({
      logger: {
        ...silentLogger,
        info: (_fields, message) => {
          said.push(message ?? '');
        },
      },
    });
    await update.tick();
    await update.tick();
    expect(said).toEqual(['main is not ahead of the running build, so it is left as it is']);
    world.head = NEWER;
    await update.tick();
    expect(said).toHaveLength(2);
  });

  it('says nothing when GitHub could not compare, and tries again next time', async () => {
    world.ahead = new Error('offline');
    const update = make();
    expect(await update.tick()).toBe('unreachable');
    expect(world.calls).toEqual([]);
    world.ahead = true;
    expect(await update.tick()).toBe('applying');
  });

  it('does nothing when main is the commit the app runs', async () => {
    world.head = RUNNING;
    const update = make();
    expect(await update.tick()).toBe('current');
    expect(update.status().availableCommit).toBeNull();
    expect(world.calls).toEqual([]);
  });

  it('stages main’s build, then pauses new work and installs it when nothing is mid-session', async () => {
    const update = make();
    expect(await update.tick()).toBe('applying');
    expect(world.calls).toEqual(['stage', 'pause', 'apply']);
    expect(update.status().availableCommit).toBe(NEW);
  });

  it('remembers the install under way, so the next start can tell how it ended', async () => {
    await make().tick();
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toEqual({ head: NEW, commit: NEW });
  });

  it('installs the newest finished build when the head’s own has not finished', async () => {
    world.head = NEWER;
    world.stage = () => Promise.resolve(STAGED_OK);
    const update = make();
    expect(await update.tick()).toBe('applying');
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toEqual({
      head: NEWER,
      commit: NEW,
    });
  });

  it('installs nothing when the newest finished build is the one that runs, however often it looks', async () => {
    world.stage = () => Promise.resolve({ ok: true, current: true, commit: RUNNING });
    const update = make();
    expect(await update.tick()).toBe('no-newer-build');
    expect(await update.tick()).toBe('no-newer-build');
    expect(world.calls).toEqual(['stage', 'stage']);
    expect(cards()).toEqual([]);
  });

  it('never installs a build that is not ahead of the running one', async () => {
    // The head's own build has not finished, and the newest one that has is older than the app.
    world.stage = () => Promise.resolve({ ...STAGED_OK, commit: 'e'.repeat(40) });
    world.stagedAhead = false;
    const update = make();
    expect(await update.tick()).toBe('no-newer-build');
    expect(world.calls).toEqual(['stage']);
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toBeUndefined();
  });

  it('raises no card, but remembers the failure, when there is no project to carry it', async () => {
    world.stage = () => Promise.resolve({ ok: false, step: 'download', message: 'offline' });
    const update = make({ cardProject: null });
    expect(await update.tick()).toBe('failed');
    expect(cards()).toEqual([]);
    expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBe(NEW);
  });

  it('holds new work back before it looks again, and waits for the scheduler to settle', async () => {
    let settle: () => void = () => undefined;
    world.pause = () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      });
    const check = make().tick();
    await waitFor(() => world.calls.includes('pause'));
    // The second look at the work waits for the scheduler: it has not run yet.
    expect(world.calls).not.toContain('apply');
    settle();
    expect(await check).toBe('applying');
  });

  it('does not resume the scheduler when it was stopped while new work was held back', async () => {
    let settle: () => void = () => undefined;
    world.pause = () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      });
    world.busyAfterPause = 1;
    const update = make();
    const check = update.tick();
    await waitFor(() => world.calls.includes('pause'));
    await update.stop();
    settle();
    await check;
    expect(world.calls).not.toContain('resume');
    expect(world.calls).not.toContain('apply');
  });

  it('does not resume the scheduler when it was stopped while the install was starting', async () => {
    const update = make();
    world.apply = () => {
      void update.stop();
      return { ok: false, step: 'start-install', message: 'spawn bash ENOENT' };
    };
    await update.tick();
    expect(world.calls).not.toContain('resume');
  });

  it('waits while a task is mid-session, and installs on a later check without staging again', async () => {
    world.busy = 1;
    const update = make();
    expect(await update.tick()).toBe('busy');
    expect(world.calls).toEqual(['stage']);
    expect(await update.tick()).toBe('busy');
    world.busy = 0;
    expect(await update.tick()).toBe('applying');
    expect(world.calls).toEqual(['stage', 'pause', 'apply']);
  });

  it('lets work go on when a lane started between the idle check and the pause', async () => {
    world.busyAfterPause = 1;
    const update = make();
    expect(await update.tick()).toBe('busy');
    expect(world.calls).toEqual(['stage', 'pause', 'resume']);
  });

  it('stages again for a commit that landed after the first was staged', async () => {
    world.busy = 1;
    const update = make();
    await update.tick();
    world.head = NEWER;
    world.busy = 0;
    expect(await update.tick()).toBe('applying');
    expect(world.calls).toEqual(['stage', 'stage', 'pause', 'apply']);
  });

  it('does not answer a second check while the first is still staging', async () => {
    let finish: (result: StageResult) => void = () => undefined;
    world.stage = () =>
      new Promise<StageResult>((resolve) => {
        finish = resolve;
      });
    const update = make();
    const first = update.tick();
    expect(await update.tick()).toBe('working');
    await settled();
    finish(STAGED_OK);
    expect(await first).toBe('applying');
    expect(world.calls.filter((call) => call === 'stage')).toHaveLength(1);
  });

  it('says nothing when GitHub cannot be reached, and tries again next time', async () => {
    world.head = new Error('offline');
    const update = make();
    expect(await update.tick()).toBe('unreachable');
    expect(cards()).toEqual([]);
    world.head = NEW;
    expect(await update.tick()).toBe('applying');
  });
});

describe('a build that fails', () => {
  beforeEach(() => {
    world.stage = () =>
      Promise.resolve({
        ok: false,
        step: 'verify-checksum',
        message: 'checksum mismatch for 10db.dmg',
      });
  });

  it('raises one card naming the step, and installs nothing', async () => {
    const update = make();
    expect(await update.tick()).toBe('failed');
    const [card, ...rest] = cards();
    expect(rest).toEqual([]);
    expect(card?.title).toContain('checking the download');
    expect(card?.body).toContain('checksum mismatch for 10db.dmg');
    expect(card?.body).toContain(RUNNING.slice(0, 12));
    expect(card?.body).toContain('make rollback-app');
    expect(world.calls).toEqual(['stage']);
  });

  it('raises no second card for the same commit however often it checks', async () => {
    const update = make();
    await update.tick();
    expect(await update.tick()).toBe('failed-before');
    expect(await update.tick()).toBe('failed-before');
    expect(world.calls).toEqual(['stage']);
    expect(cards()).toHaveLength(1);
  });

  it('tries the next commit, with a card of its own if that fails too', async () => {
    const update = make();
    await update.tick();
    world.head = NEWER;
    expect(await update.tick()).toBe('failed');
    expect(world.calls).toEqual(['stage', 'stage']);
    expect(cards()).toHaveLength(2);
  });

  it('tries the same commit again once the builder asks, folding into the open card', async () => {
    const update = make();
    await update.tick();
    update.retry();
    expect(await update.tick()).toBe('failed');
    expect(world.calls).toEqual(['stage', 'stage']);
    expect(cards()).toHaveLength(1);
  });

  it('keeps the app running: nothing is paused', async () => {
    await make().tick();
    expect(world.calls).not.toContain('pause');
  });
});

describe('an install that cannot start', () => {
  it('lets work go on and raises one card naming the step', async () => {
    world.apply = () => ({ ok: false, step: 'start-install', message: 'spawn bash ENOENT' });
    const update = make();
    expect(await update.tick()).toBe('failed');
    expect(world.calls).toEqual(['stage', 'pause', 'apply', 'resume']);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.body).toContain('spawn bash ENOENT');
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toBeUndefined();
    expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBe(NEW);
  });

  it('lets work go on, forgets the install and raises one card when starting it throws', async () => {
    // As the installer's own file calls do when the log can't be opened: before any promise.
    world.apply = () => {
      throw new Error("EMFILE: too many open files, open '/data/self-update/apply.log'");
    };
    const update = make();
    expect(await update.tick()).toBe('failed');
    expect(world.calls).toEqual(['stage', 'pause', 'apply', 'resume']);
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toBeUndefined();
    expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBe(NEW);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.title).toContain('starting the install');
    expect(cards()[0]?.body).toContain('EMFILE');
    // Checks go on, and neither pause the scheduler again nor try the failed commit.
    expect(await update.tick()).toBe('failed-before');
    expect(world.calls).toEqual(['stage', 'pause', 'apply', 'resume']);
  });

  it('lets work go on and raises one card when holding new work back fails', async () => {
    world.pause = () => Promise.reject(new Error('the scheduler could not settle'));
    const update = make();
    expect(await update.tick()).toBe('failed');
    expect(world.calls).toEqual(['stage', 'pause', 'resume']);
    expect(cards()[0]?.body).toContain('the scheduler could not settle');
  });

  it('touches nothing when starting the install throws after the daemon stopped', async () => {
    const update = make();
    world.apply = () => {
      void update.stop();
      throw new Error('EMFILE');
    };
    expect(await update.tick()).toBe('working');
    expect(world.calls).not.toContain('resume');
    expect(cards()).toEqual([]);
  });
});

describe('stop', () => {
  it('stops a stage under way and settles once it has stopped, with no card', async () => {
    let finish: (result: StageResult) => void = () => undefined;
    world.stage = () =>
      new Promise<StageResult>((resolve) => {
        finish = resolve;
      });
    let stageStopped: () => void = () => undefined;
    world.stopStage = () =>
      new Promise<void>((resolve) => {
        stageStopped = () => {
          // The killed script ends the stage it was running as a failure.
          finish({ ok: false, step: 'stage', message: 'killed' });
          resolve();
        };
      });
    const update = make();
    const check = update.tick();
    await waitFor(() => world.calls.includes('stage'));
    let stopped = false;
    const stopping = update.stop().then(() => {
      stopped = true;
    });
    await waitFor(() => world.calls.includes('stop-stage'));
    await settled();
    expect(stopped).toBe(false);
    stageStopped();
    await stopping;
    expect(await check).toBe('working');
    expect(cards()).toEqual([]);
    expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBeUndefined();
  });
});

describe('an install that fails before the app quits', () => {
  it('lets work go on, stops reporting an install, and raises one card naming the step', async () => {
    const update = make();
    expect(await update.tick()).toBe('applying');
    expect(await update.tick()).toBe('working');
    world.status = {
      ok: false,
      step: 'lock',
      message: 'another make install-app or make rollback-app holds the lock',
      commit: NEW,
    };
    world.endScript();
    await settled();
    expect(world.calls).toEqual(['stage', 'pause', 'apply', 'resume']);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.title).toContain('taking the install lock');
    expect(cards()[0]?.body).toContain('holds the lock');
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toBeUndefined();
    expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBe(NEW);
    expect(world.status).toBeNull();
    // Checks go on, and do not try the failed commit again.
    expect(await update.tick()).toBe('failed-before');
  });

  it('names the quit step when the app would not quit in time', async () => {
    const update = make();
    await update.tick();
    world.status = {
      ok: false,
      step: 'quit',
      message: '10db did not quit within 90 seconds',
      commit: NEW,
    };
    world.endScript();
    await settled();
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.title).toContain('quitting 10db');
  });

  it('raises a card when the script ended without a status and this app is still running', async () => {
    const update = make();
    await update.tick();
    world.endScript();
    await settled();
    expect(world.calls).toContain('resume');
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.body).toContain('left no report');
  });

  it('says nothing once the daemon is stopping: the app was quit, and the next start reports it', async () => {
    const update = make();
    await update.tick();
    await update.stop();
    world.status = { ok: false, step: 'install', message: 'ditto failed', commit: NEW };
    world.endScript();
    await settled();
    expect(world.calls).not.toContain('resume');
    expect(cards()).toEqual([]);
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toEqual({ head: NEW, commit: NEW });
  });
});

describe('settle, at the start of a daemon', () => {
  /** The daemon that began the install records it and quits; the next one starts running `running`. */
  async function startedAfterInstall(
    running: string,
    status: ScriptStatus | null,
  ): Promise<SelfUpdate> {
    await make().tick();
    world.calls.length = 0;
    world.status = status;
    return make({ runningCommit: running });
  }

  it('is silent when the app now runs the commit that was being installed', async () => {
    const update = await startedAfterInstall(NEW, {
      ok: true,
      step: 'done',
      message: '',
      commit: NEW,
    });
    update.settle();
    expect(cards()).toEqual([]);
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toBeUndefined();
    expect(world.status).toBeNull();
  });

  it('raises one card with the failing step when the install failed and the old app came back', async () => {
    const update = await startedAfterInstall(RUNNING, {
      ok: false,
      step: 'backup-database',
      message: 'sqlite3 could not back up the database',
      commit: NEW,
    });
    update.settle();
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.title).toContain('backing up the database');
    expect(cards()[0]?.body).toContain('sqlite3 could not back up the database');
    expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBe(NEW);
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toBeUndefined();
    expect(world.status).toBeNull();
  });

  it('raises a card even when the install left no status', async () => {
    const update = await startedAfterInstall(RUNNING, null);
    update.settle();
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.body).toContain('did not finish');
  });

  it('does nothing when no install was under way', () => {
    world.status = { ok: false, step: 'quit', message: 'stale', commit: NEW };
    make().settle();
    expect(cards()).toEqual([]);
    expect(world.status).toBeNull();
  });
});

describe('start', () => {
  it('checks every interval until stopped', async () => {
    let heads = 0;
    const update = make({
      headOf: () => {
        heads += 1;
        return Promise.resolve(RUNNING);
      },
    });
    update.start();
    clock.advance(120_000);
    await settled();
    clock.advance(120_000);
    await settled();
    expect(heads).toBe(2);
    await update.stop();
    clock.advance(600_000);
    await settled();
    expect(heads).toBe(2);
  });
});
