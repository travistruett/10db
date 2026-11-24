import type { ProjectId, ShapeId } from '@10db/contracts';
import { createTestStore, getAppSetting, listInbox, seedProject, setAppSetting } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger, type Logger } from '../log';
import { createStatusService, type StatusService } from '../status';
import {
  createSelfUpdate,
  SELF_UPDATE_APPLYING_KEY,
  type ApplyResult,
  type ScriptStatus,
  type SelfUpdate,
  type StageResult,
} from './self-update';

const RUNNING = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const STAGED = { dir: '/data/self-update/stage', commit: NEW };
const STAGED_OK: StageResult = { ok: true, current: false, ...STAGED };
const WAIT_LIMIT_MS = 15 * 60_000;

let close: () => void;
let state: StateStore;
let projectId: ProjectId;
let clock: ManualClock;
let statusService: StatusService;

/** Everything the update asks of the outside world, scripted per test. */
interface World {
  head: string | Error;
  /** Whether main's head is ahead of the running commit, as GitHub's comparison says. */
  ahead: boolean | Error;
  /** Whether the staged build is ahead of the running commit; an error when GitHub can't say. */
  stagedAhead: boolean | Error;
  /** The repositories and running commits stage was asked about. */
  stagedFrom: string[];
  stagedFor: string[];
  /** The commit each stage was told not to fetch: the one the builder rolled back from. */
  stagedSkipping: (string | null)[];
  /** The commit already staged that each stage was told to keep when it is still the newest. */
  stagedKeeping: (string | null)[];
  stage: () => Promise<StageResult>;
  /** Stops a stage under way, as the installer kills the script's process group. */
  stopStage: () => Promise<void>;
  /** Kills a stage under way because the switch was turned off; later stages still run. */
  cancelStage: () => Promise<void>;
  /** Whether the builder's switch is on; a test turns it off part way. */
  enabled: boolean;
  /** The commit make rollback-app recorded it replaced, until the daemon takes it in. */
  rolledBackFrom: string | null;
  /** Called as the installer's apply is: a throw here is a synchronous throw from apply. */
  apply: () => { readonly ok: true } | Extract<ApplyResult, { ok: false }>;
  /** Settles when apply answers: until then the install is starting. */
  applyAnswers: Promise<void>;
  busy: number;
  /** The shaping conversations whose turn runs: part of `busy`, named. */
  shapes: { id: ShapeId; title: string }[];
  /** How long a staged build waits for an idle moment before the factory drains for it. */
  waitLimitMs: number;
  /** When the drain began, as the update told the factory; null while it does not drain. */
  drainedSince: Date | null;
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
    /** Whether `head` is ahead of `base`; the default answers from `world`. */
    isAhead?: (repo: string, base: string, head: string) => Promise<boolean>;
    logger?: Logger;
    inbox?: InboxService;
  } = {},
): SelfUpdate {
  return createSelfUpdate({
    state,
    inbox: overrides.inbox ?? createInboxService({ state, onParkedAnswer: () => undefined }),
    status: statusService,
    clock,
    logger: overrides.logger ?? silentLogger,
    runningCommit: overrides.runningCommit === undefined ? RUNNING : overrides.runningCommit,
    intervalMs: 120_000,
    repository: 'o/10db',
    enabled: () => overrides.enabled !== false && world.enabled,
    cardProject: () => (overrides.cardProject === undefined ? projectId : overrides.cardProject),
    headOf:
      overrides.headOf ??
      (() =>
        world.head instanceof Error ? Promise.reject(world.head) : Promise.resolve(world.head)),
    isAhead:
      overrides.isAhead ??
      ((_repo, _base, head) => {
        if (head === world.head) {
          return world.ahead instanceof Error
            ? Promise.reject(world.ahead)
            : Promise.resolve(world.ahead);
        }
        return world.stagedAhead instanceof Error
          ? Promise.reject(world.stagedAhead)
          : Promise.resolve(world.stagedAhead);
      }),
    stage: (target, running, skip, keep) => {
      world.calls.push('stage');
      world.stagedFrom.push(target.repo);
      world.stagedFor.push(running);
      world.stagedSkipping.push(skip);
      world.stagedKeeping.push(keep);
      return world.stage();
    },
    stopStage: () => {
      world.calls.push('stop-stage');
      return world.stopStage();
    },
    cancelStage: () => {
      world.calls.push('cancel-stage');
      return world.cancelStage();
    },
    rollback: {
      read: () => world.rolledBackFrom,
      clear: () => {
        world.calls.push('clear-rollback');
        world.rolledBackFrom = null;
      },
    },
    apply: () => {
      world.calls.push('apply');
      const result = world.apply();
      if (!result.ok) return world.applyAnswers.then(() => result);
      const ended = new Promise<void>((resolve) => {
        world.endScript = resolve;
      });
      return world.applyAnswers.then(() => ({ ...result, ended }));
    },
    midSession: () => world.busy,
    shapeTurns: () => world.shapes,
    waitLimitMs: () => world.waitLimitMs,
    drain: {
      begin: (since) => {
        world.calls.push('drain');
        world.drainedSince = since;
      },
      end: () => {
        world.calls.push('undrain');
        world.drainedSince = null;
      },
    },
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

beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  projectId = seedProject(test.store).id;
  clock = new ManualClock();
  statusService = createStatusService({ clock, onChange: () => undefined });
  world = {
    head: NEW,
    ahead: true,
    stagedAhead: true,
    stagedFrom: [],
    stagedFor: [],
    stagedSkipping: [],
    stagedKeeping: [],
    pause: () => Promise.resolve(),
    stage: () => Promise.resolve(STAGED_OK),
    stopStage: () => Promise.resolve(),
    cancelStage: () => Promise.resolve(),
    enabled: true,
    rolledBackFrom: null,
    apply: () => ({ ok: true }),
    applyAnswers: Promise.resolve(),
    busy: 0,
    shapes: [],
    waitLimitMs: WAIT_LIMIT_MS,
    drainedSince: null,
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
  it('stages from the repository the app was built for, and no other', async () => {
    await make().tick();
    expect(world.stagedFrom).toEqual(['o/10db']);
    expect(world.stagedFor).toEqual([RUNNING]);
    expect(world.stagedSkipping).toEqual([null]);
  });

  it('does nothing when main is not ahead of the running commit: a build from another branch stays', async () => {
    world.ahead = false;
    const update = make();
    expect(await update.tick()).toBe('not-ahead');
    expect(update.status().availableCommit).toBeNull();
    expect(world.calls).toEqual([]);
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

  it('closes its card once a later update installs, whichever build the card was for', async () => {
    expect(await make().tick()).toBe('failed');
    expect(cards()).toHaveLength(1);
    state.write((ctx) => {
      setAppSetting(ctx, SELF_UPDATE_APPLYING_KEY, { commit: RUNNING, head: 'c'.repeat(40) });
    });
    make().settle();
    expect(cards().map((c) => c.state)).toEqual(['RESOLVED']);
  });

  it('raises no second card for the same commit however often it checks', async () => {
    const update = make();
    await update.tick();
    expect(await update.tick()).toBe('failed-before');
    expect(await update.tick()).toBe('failed-before');
    expect(world.calls).toEqual(['stage']);
    expect(cards()).toHaveLength(1);
  });
});

describe('after make rollback-app', () => {
  /** A daemon started on RUNNING after the builder rolled back from NEW. */
  function rolledBack(): SelfUpdate {
    world.rolledBackFrom = NEW;
    const update = make();
    update.settle();
    return update;
  }

  it('installs nothing for the head of main it rolled back from', async () => {
    const update = rolledBack();
    expect(await update.tick()).toBe('rolled-back');
    expect(await update.tick()).toBe('rolled-back');
    expect(world.calls).toEqual(['clear-rollback']);
    expect(cards()).toEqual([]);
  });
});
