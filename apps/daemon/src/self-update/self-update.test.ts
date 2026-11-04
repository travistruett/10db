import {
  InboxState,
  mintId,
  SELF_UPDATE_SWITCH,
  type ProjectId,
  type ShapeId,
} from '@10db/contracts';
import { createTestStore, getAppSetting, listInbox, seedProject, setAppSetting } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { GhError, GhFailure } from '../github';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger, type Logger } from '../log';
import {
  createSelfUpdate,
  SELF_UPDATE_APPLYING_KEY,
  SELF_UPDATE_FAILED_KEY,
  SHAPE_HOLD_ALERT_MS,
  SHAPE_HOLD_FOLD_KEY,
  type ApplyResult,
  type ScriptStatus,
  type SelfUpdate,
  type StageResult,
} from './self-update';

const RUNNING = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);
/** A build that finished before the head's: the one the builder rolled back from. */
const OLD_BUILD = 'd'.repeat(40);
const STAGED = { dir: '/data/self-update/stage', commit: NEW };
const STAGED_OK: StageResult = { ok: true, current: false, ...STAGED };
const WAIT_LIMIT_MS = 15 * 60_000;

let close: () => void;
let state: StateStore;
let projectId: ProjectId;
let clock: ManualClock;

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
    logger?: Logger;
    inbox?: InboxService;
  } = {},
): SelfUpdate {
  return createSelfUpdate({
    state,
    inbox: overrides.inbox ?? createInboxService({ state, onParkedAnswer: () => undefined }),
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
    isAhead: (_repo, _base, head) => {
      if (head === world.head) {
        return world.ahead instanceof Error
          ? Promise.reject(world.ahead)
          : Promise.resolve(world.ahead);
      }
      return world.stagedAhead instanceof Error
        ? Promise.reject(world.stagedAhead)
        : Promise.resolve(world.stagedAhead);
    },
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
    expect(world.stagedSkipping).toEqual([null]);
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

  it('installs a newer finished build, not the staged older one, when the head’s build finishes while lanes are busy', async () => {
    world.head = NEWER;
    world.busy = 1;
    // The head's own build is still running, so the stage found only NEW.
    world.stage = () => Promise.resolve(STAGED_OK);
    const update = make();
    expect(await update.tick()).toBe('busy');
    // Main's head did not move, but its build finished while the lanes ran.
    world.stage = () =>
      Promise.resolve({ ok: true, current: false, dir: STAGED.dir, commit: NEWER });
    world.busy = 0;
    expect(await update.tick()).toBe('applying');
    expect(world.calls.filter((call) => call === 'stage')).toHaveLength(2);
    expect(world.calls.filter((call) => call === 'apply')).toHaveLength(1);
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toEqual({
      head: NEWER,
      commit: NEWER,
    });
  });

  it('tells each stage which build is already staged, so a stage that finds the same one fetches nothing', async () => {
    world.busy = 1;
    const update = make();
    expect(await update.tick()).toBe('busy');
    // Main moves, but its newest finished build is still the staged NEW: the stage keeps it.
    world.head = NEWER;
    expect(await update.tick()).toBe('busy');
    expect(world.stagedKeeping).toEqual([null, NEW]);
    // The kept build is the one that installs once the lanes are done.
    world.busy = 0;
    expect(await update.tick()).toBe('applying');
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toEqual({
      head: NEWER,
      commit: NEW,
    });
  });

  it('asks again for a newer finished build, keeping the staged one, before it installs', async () => {
    world.head = NEWER;
    world.busy = 1;
    const update = make();
    expect(await update.tick()).toBe('busy');
    world.busy = 0;
    world.stage = () =>
      Promise.resolve({ ok: true, current: false, dir: STAGED.dir, commit: NEWER });
    expect(await update.tick()).toBe('applying');
    expect(world.stagedKeeping).toEqual([null, NEW]);
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toEqual({
      head: NEWER,
      commit: NEWER,
    });
  });

  it('stages again only when no task is mid-session, so busy lanes cost no download', async () => {
    world.head = NEWER;
    world.busy = 1;
    const update = make();
    expect(await update.tick()).toBe('busy');
    expect(await update.tick()).toBe('busy');
    expect(world.calls).toEqual(['stage']);
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

  it('keeps the failure for Settings when there is no project to carry a card', async () => {
    world.stage = () =>
      Promise.resolve({ ok: false, step: 'download', message: 'curl: connection reset' });
    const update = make({ cardProject: null });
    expect(update.status().problem).toBeNull();
    await update.tick();
    expect(update.status().problem).toMatchObject({ kind: 'failed' });
    expect(update.status().problem?.message).toContain('downloading the build');
    expect(update.status().problem?.message).toContain('curl: connection reset');
    expect(update.status().problem?.message).toContain(NEW.slice(0, 12));
    // Later checks skip the failed head, and Settings goes on saying why.
    expect(await update.tick()).toBe('failed-before');
    expect(update.status().problem).toMatchObject({ kind: 'failed' });
  });

  it('drops the failure when the builder asks again, and when main moves on', async () => {
    world.stage = () => Promise.resolve({ ok: false, step: 'download', message: 'offline' });
    const update = make({ cardProject: null });
    await update.tick();
    update.retry();
    expect(update.status().problem).toBeNull();
    await update.tick();
    world.head = RUNNING;
    await update.tick();
    expect(update.status().problem).toBeNull();
  });

  it('says it could not reach GitHub while the check fails, and stops saying it once one succeeds', async () => {
    const update = make();
    expect(update.status().problem).toBeNull();
    world.head = new GhError(GhFailure.Unreachable, 'gh api failed: dial tcp: i/o timeout');
    expect(await update.tick()).toBe('unreachable');
    expect(update.status().problem?.kind).toBe('unreachable');
    expect(update.status().problem?.message).toMatch(/offline/i);
    world.head = RUNNING;
    expect(await update.tick()).toBe('current');
    expect(update.status().problem).toBeNull();
  });

  it('gives a signed-out gh, an offline machine and an error GitHub answered each their own reason', async () => {
    const reasons: string[] = [];
    for (const error of [
      new GhError(GhFailure.SignedOut, 'gh is not signed in. Run gh auth login in a terminal.'),
      new GhError(GhFailure.Unreachable, 'gh api failed (exit 1): error connecting to github.com'),
      new GhError(GhFailure.Failed, 'gh api failed (exit 1): gh: Not Found (HTTP 404)'),
    ]) {
      world.head = error;
      const update = make();
      expect(await update.tick()).toBe('unreachable');
      reasons.push(update.status().problem?.message ?? '');
    }
    expect(reasons[0]).toMatch(/signed out/i);
    expect(reasons[0]).toMatch(/gh auth login/);
    expect(reasons[1]).toMatch(/offline/i);
    expect(reasons[1]).not.toMatch(/signed out/i);
    expect(reasons[2]).toMatch(/HTTP 404/);
    expect(reasons[2]).not.toMatch(/signed out|offline/i);
    expect(new Set(reasons).size).toBe(3);
  });

  it('points at the repository only for an error that fits it, and always reads as a sentence', async () => {
    const reasons: string[] = [];
    for (const message of [
      'gh api failed (exit 1): gh: API rate limit exceeded (HTTP 403)',
      'gh api failed (exit 1): gh: secondary rate limit (HTTP 403)',
      'gh api failed (exit 1): gh: Bad Gateway (HTTP 502)',
      'gh api failed (exit 1): gh: Not Found (HTTP 404)',
      'gh api failed (exit 1): ',
    ]) {
      world.head = new GhError(GhFailure.Failed, message);
      const update = make();
      expect(await update.tick()).toBe('unreachable');
      reasons.push(update.status().problem?.message ?? '');
    }
    for (const reason of reasons.slice(0, 3)) {
      expect(reason).not.toMatch(/repository|account/i);
      expect(reason).toMatch(/tries again/);
    }
    expect(reasons[0]).toMatch(/rate limit/i);
    expect(reasons[2]).toMatch(/HTTP 502/);
    expect(reasons[3]).toMatch(/repository/);
    for (const reason of reasons) {
      expect(reason).not.toMatch(/:\s*\.|:\s*$/);
    }
    expect(reasons[4]).toMatch(/exit 1\)/);
  });

  it('names the error GitHub answered when the comparison is what failed, and when gh is not installed or times out', async () => {
    world.ahead = new GhError(GhFailure.Failed, 'gh api failed (exit 1): HTTP 403 rate limit');
    const update = make();
    expect(await update.tick()).toBe('unreachable');
    expect(update.status().problem?.message).toMatch(/HTTP 403 rate limit/);
    world.ahead = true;
    world.head = new GhError(GhFailure.NotInstalled, 'no gh');
    expect(await update.tick()).toBe('unreachable');
    expect(update.status().problem?.message).toMatch(/not installed/i);
    world.head = new GhError(GhFailure.Timeout, 'gh api gave no answer within 30 s');
    expect(await update.tick()).toBe('unreachable');
    expect(update.status().problem?.message).toMatch(/no answer/i);
  });

  it('does not blame sign-in or the network for a failure it cannot classify', async () => {
    world.head = new Error('something odd');
    const update = make();
    expect(await update.tick()).toBe('unreachable');
    const message = update.status().problem?.message ?? '';
    expect(message).toMatch(/something odd/);
    expect(message).not.toMatch(/signed out|offline/i);
  });

  it('says nothing about GitHub while the switch is off', async () => {
    world.head = new Error('offline');
    const update = make();
    await update.tick();
    world.enabled = false;
    await update.tick();
    expect(update.status().problem).toBeNull();
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

describe('a drain that only shaping conversations hold', () => {
  const DENSER = { id: mintId('Shape'), title: 'Denser board' };
  const shapeCards = () =>
    listInbox(state.db, {}).filter((item) => item.title.startsWith('A shaping conversation'));

  /** Drains for `busy` turns of conversations, with no lane or gate running. */
  async function drainingForShapes(...shapes: { id: ShapeId; title: string }[]) {
    world.busy = shapes.length;
    world.shapes = shapes;
    world.waitLimitMs = 0;
    const update = make();
    expect(await update.tick()).toBe('draining');
    return update;
  }

  it('raises no card at first: a turn is expected to end on its own', async () => {
    await (await drainingForShapes(DENSER)).tick();
    expect(shapeCards()).toEqual([]);
  });

  it('tells the builder, once, which conversation keeps lanes paused past the limit', async () => {
    const update = await drainingForShapes(DENSER);
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    const [card, ...rest] = shapeCards();
    expect(rest).toEqual([]);
    expect(card?.title).toBe('A shaping conversation is holding the update, and lanes are paused');
    expect(card?.body).toContain('“Denser board”');
    expect(card?.body).toContain('press Stop');
    // Stop only interrupts: a session that ignores it needs a way out that does not depend on it.
    expect(card?.body).toContain(`turn ${SELF_UPDATE_SWITCH} off`);
    expect(card?.body).toContain('quit 10db');
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    expect(shapeCards()).toHaveLength(1);
  });

  it('names every conversation that holds it', async () => {
    const update = await drainingForShapes(DENSER, { id: mintId('Shape'), title: 'Login flow' });
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    expect(shapeCards()[0]?.body).toMatch(/“Denser board”.*“Login flow”/);
  });

  it('names only the conversations still holding it once one of them ends', async () => {
    const login = { id: mintId('Shape'), title: 'Login flow' };
    const update = await drainingForShapes(DENSER, login);
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    world.busy = 1;
    world.shapes = [login];
    await update.tick();
    const open = shapeCards().filter((item) => item.state === InboxState.Open);
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toContain('“Login flow”');
    expect(open[0]?.body).not.toContain('“Denser board”');
  });

  it('raises none while a lane or gate also holds the drain', async () => {
    const update = await drainingForShapes(DENSER);
    world.busy = 2;
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    expect(shapeCards()).toEqual([]);
  });

  it('does not count the time a lane held it before the conversation was the only holder', async () => {
    world.busy = 2;
    world.shapes = [DENSER];
    world.waitLimitMs = 0;
    const update = make();
    await update.tick();
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    expect(shapeCards()).toEqual([]);
    world.busy = 1;
    await update.tick();
    expect(shapeCards()).toEqual([]);
  });

  it('closes the card once the turn ends and the install can go on', async () => {
    const update = await drainingForShapes(DENSER);
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    expect(shapeCards()).toHaveLength(1);
    world.busy = 0;
    world.shapes = [];
    expect(await update.tick()).toBe('applying');
    expect(shapeCards()[0]?.state).toBe(InboxState.Resolved);
  });

  it('closes the card when the drain ends for another reason', async () => {
    const update = await drainingForShapes(DENSER);
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    await update.turnOff();
    expect(shapeCards()[0]?.state).toBe(InboxState.Resolved);
  });

  it('raises a card again for a later hold', async () => {
    const update = await drainingForShapes(DENSER);
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    world.enabled = false;
    await update.tick();
    world.enabled = true;
    await update.tick();
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    expect(shapeCards().filter((item) => item.state === InboxState.Open)).toHaveLength(1);
  });

  describe('after a restart', () => {
    /** A card a run before this one left open, on `project`: nothing in this run holds it. */
    function cardLeftOpen(project: ProjectId) {
      createInboxService({ state, onParkedAnswer: () => undefined }).flag({
        projectId: project,
        workstreamId: null,
        title: 'A shaping conversation is holding the update, and lanes are paused',
        body: 'Left by an earlier run.',
        foldKey: SHAPE_HOLD_FOLD_KEY,
      });
    }

    it('closes a card an earlier run left open: nothing holds the update now', () => {
      cardLeftOpen(projectId);
      make().settle();
      expect(shapeCards().map((card) => card.state)).toEqual([InboxState.Resolved]);
    });

    it('closes it under a project that no longer places the cards', () => {
      cardLeftOpen(projectId);
      make({ cardProject: null }).settle();
      expect(shapeCards().map((card) => card.state)).toEqual([InboxState.Resolved]);
    });

    it('closes it when no install was under way and in a run with no commit', () => {
      cardLeftOpen(projectId);
      make({ runningCommit: null }).settle();
      expect(shapeCards().map((card) => card.state)).toEqual([InboxState.Resolved]);
    });

    it('still reports how an install ended when a card can not be closed', () => {
      cardLeftOpen(projectId);
      state.write((ctx) => {
        setAppSetting(ctx, SELF_UPDATE_APPLYING_KEY, { head: NEW, commit: NEW });
      });
      const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
      const refusing: InboxService = {
        ...inbox,
        resolve: () => {
          throw new Error('the database is busy');
        },
      };
      make({ inbox: refusing }).settle();
      expect(cards()).toHaveLength(1);
    });

    it('raises a card again if a hold really recurs', async () => {
      cardLeftOpen(projectId);
      make().settle();
      const update = await drainingForShapes(DENSER);
      clock.advance(SHAPE_HOLD_ALERT_MS);
      await update.tick();
      expect(shapeCards().filter((item) => item.state === InboxState.Open)).toHaveLength(1);
    });
  });
});

describe('a waiting update drains the factory', () => {
  it('waits quietly while the update has waited less than the limit', async () => {
    world.busy = 3;
    const update = make();
    await update.tick();
    clock.advance(WAIT_LIMIT_MS - 1);
    expect(await update.tick()).toBe('busy');
    expect(world.calls).not.toContain('drain');
    expect(update.status().draining).toBe(false);
  });

  it('says since when the update has waited', async () => {
    world.busy = 3;
    const update = make();
    expect(update.status().waitingSince).toBeNull();
    const stagedAt = clock.now();
    await update.tick();
    expect(update.status().waitingSince).toEqual(stagedAt);
    clock.advance(60_000);
    await update.tick();
    expect(update.status().waitingSince).toEqual(stagedAt);
  });

  it('starts the drain once the update has waited the limit, and says since when', async () => {
    world.busy = 3;
    const update = make();
    await update.tick();
    clock.advance(WAIT_LIMIT_MS);
    const drainStart = clock.now();
    expect(await update.tick()).toBe('draining');
    expect(world.calls).toEqual(['stage', 'drain']);
    expect(world.drainedSince).toEqual(drainStart);
    expect(update.status().draining).toBe(true);
    expect(update.status().drainingSince).toEqual(drainStart);
    // Another look while it drains does not start it again.
    clock.advance(60_000);
    expect(await update.tick()).toBe('draining');
    expect(world.calls).toEqual(['stage', 'drain']);
    expect(update.status().drainingSince).toEqual(drainStart);
  });

  it('drains at once with a limit of 0 minutes', async () => {
    world.busy = 1;
    world.waitLimitMs = 0;
    expect(await make().tick()).toBe('draining');
  });

  it('installs when the running steps have finished, and keeps holding new work until the relaunch', async () => {
    world.busy = 3;
    const update = make();
    await update.tick();
    clock.advance(WAIT_LIMIT_MS);
    await update.tick();
    world.busy = 1;
    expect(await update.tick()).toBe('draining');
    world.busy = 0;
    expect(await update.tick()).toBe('applying');
    expect(world.calls).toEqual(['stage', 'drain', 'pause', 'apply']);
    expect(update.status().draining).toBe(true);
  });

  it('lets lanes start again when the install does not start', async () => {
    world.busy = 3;
    world.waitLimitMs = 0;
    const update = make();
    await update.tick();
    world.busy = 0;
    world.apply = () => ({ ok: false, step: 'start-install', message: 'spawn bash ENOENT' });
    expect(await update.tick()).toBe('failed');
    expect(world.calls).toEqual(['stage', 'drain', 'pause', 'apply', 'resume', 'undrain']);
    expect(update.status().draining).toBe(false);
    expect(update.status().waitingSince).toBeNull();
  });

  it('lets lanes start again when the install script ends with this daemon still running', async () => {
    world.busy = 3;
    world.waitLimitMs = 0;
    const update = make();
    await update.tick();
    world.busy = 0;
    await update.tick();
    world.status = { ok: false, step: 'quit', message: 'would not quit', commit: NEW };
    world.endScript();
    await waitFor(() => world.calls.includes('undrain'));
    expect(update.status().draining).toBe(false);
  });

  it('keeps draining when a lane started between the idle check and the pause', async () => {
    world.busy = 3;
    world.waitLimitMs = 0;
    const update = make();
    await update.tick();
    world.busy = 0;
    world.busyAfterPause = 1;
    expect(await update.tick()).toBe('busy');
    expect(world.calls).not.toContain('undrain');
  });

  it('cancels the drain when the switch is turned off', async () => {
    world.busy = 3;
    world.waitLimitMs = 0;
    const update = make();
    await update.tick();
    expect(update.status().draining).toBe(true);
    await update.turnOff();
    expect(world.calls).toContain('undrain');
    expect(update.status().draining).toBe(false);
    expect(update.status().waitingSince).toBeNull();
  });

  it('cancels the drain when a check finds the switch off', async () => {
    world.busy = 3;
    world.waitLimitMs = 0;
    const update = make();
    await update.tick();
    world.enabled = false;
    expect(await update.tick()).toBe('off');
    expect(update.status().draining).toBe(false);
  });

  it('cancels the drain when main is back at the running commit', async () => {
    world.busy = 3;
    world.waitLimitMs = 0;
    const update = make();
    await update.tick();
    world.head = RUNNING;
    expect(await update.tick()).toBe('current');
    expect(update.status().draining).toBe(false);
    expect(update.status().waitingSince).toBeNull();
  });

  describe('once the install has started', () => {
    /** Drains for a lane, which ends, so the next check starts the install. */
    async function installing() {
      world.busy = 1;
      world.waitLimitMs = 0;
      const update = make();
      await update.tick();
      world.busy = 0;
      return update;
    }

    it('holds lanes back when the switch is turned off as the install starts: the quit would cut them off', async () => {
      let answer: () => void = () => undefined;
      world.applyAnswers = new Promise<void>((resolve) => {
        answer = resolve;
      });
      const update = await installing();
      const check = update.tick();
      await waitFor(() => world.calls.includes('apply'));
      world.enabled = false;
      await update.turnOff();
      expect(update.status().draining).toBe(true);
      expect(world.calls).not.toContain('undrain');
      answer();
      expect(await check).toBe('applying');
      expect(update.status().draining).toBe(true);
      expect(world.calls).not.toContain('undrain');
    });

    it('holds lanes back when the switch is turned off with the install script running', async () => {
      const update = await installing();
      expect(await update.tick()).toBe('applying');
      world.enabled = false;
      await update.turnOff();
      expect(update.status().draining).toBe(true);
      expect(world.calls).not.toContain('undrain');
      // A check while the script runs changes nothing.
      expect(await update.tick()).toBe('working');
      expect(world.calls).not.toContain('undrain');
    });

    it('lets lanes start again when the switch was turned off and the install then ends with this daemon running', async () => {
      const update = await installing();
      await update.tick();
      world.enabled = false;
      await update.turnOff();
      world.status = { ok: false, step: 'quit', message: 'would not quit', commit: NEW };
      world.endScript();
      await waitFor(() => world.calls.includes('undrain'));
      expect(update.status().draining).toBe(false);
    });

    it('lets lanes start again when the switch was turned off and the install then does not start', async () => {
      let answer: () => void = () => undefined;
      world.applyAnswers = new Promise<void>((resolve) => {
        answer = resolve;
      });
      world.apply = () => ({ ok: false, step: 'start-install', message: 'spawn bash ENOENT' });
      const update = await installing();
      const check = update.tick();
      await waitFor(() => world.calls.includes('apply'));
      world.enabled = false;
      await update.turnOff();
      expect(update.status().draining).toBe(true);
      answer();
      expect(await check).toBe('failed');
      expect(update.status().draining).toBe(false);
      expect(world.calls).toContain('undrain');
    });

    it('turns off as ever when the install did not start: the next one is not held up', async () => {
      world.apply = () => ({ ok: false, step: 'start-install', message: 'spawn bash ENOENT' });
      const update = await installing();
      expect(await update.tick()).toBe('failed');
      world.busy = 1;
      world.apply = () => ({ ok: true });
      world.head = NEWER;
      expect(await update.tick()).toBe('draining');
      world.enabled = false;
      await update.turnOff();
      expect(update.status().draining).toBe(false);
    });
  });

  describe('while GitHub cannot be reached', () => {
    const lost: readonly (readonly [string, () => void])[] = [
      [
        'the head of main',
        () => {
          world.head = new Error('offline');
        },
      ],
      [
        'how main compares',
        () => {
          world.ahead = new Error('offline');
        },
      ],
    ];

    it.each(lost)(
      'installs the staged build once the running steps end, unable to ask %s',
      async (_name, lose) => {
        world.busy = 1;
        world.waitLimitMs = 0;
        const update = make();
        expect(await update.tick()).toBe('draining');
        lose();
        expect(await update.tick()).toBe('draining');
        expect(world.calls).not.toContain('undrain');
        world.busy = 0;
        expect(await update.tick()).toBe('applying');
        expect(world.calls).toEqual(['stage', 'drain', 'pause', 'apply']);
      },
    );

    it('starts the drain for a staged build that has waited the limit', async () => {
      world.busy = 1;
      const update = make();
      await update.tick();
      clock.advance(WAIT_LIMIT_MS);
      world.head = new Error('offline');
      expect(await update.tick()).toBe('draining');
    });

    it('installs a staged build at an idle moment, with no drain', async () => {
      world.busy = 1;
      const update = make();
      await update.tick();
      world.head = new Error('offline');
      world.busy = 0;
      expect(await update.tick()).toBe('applying');
    });

    it('does not try a staged build again once its install failed', async () => {
      world.busy = 1;
      world.waitLimitMs = 0;
      const update = make();
      await update.tick();
      world.busy = 0;
      world.apply = () => ({ ok: false, step: 'start-install', message: 'spawn bash ENOENT' });
      expect(await update.tick()).toBe('failed');
      world.head = new Error('offline');
      expect(await update.tick()).toBe('unreachable');
      expect(world.calls.filter((call) => call === 'apply')).toEqual(['apply']);
      expect(update.status().draining).toBe(false);
    });

    /** Drains for a build, then main moves on and the build fetched for it can't be compared. */
    async function drainedThenLostNewBuild() {
      world.busy = 1;
      const update = make();
      await update.tick();
      clock.advance(WAIT_LIMIT_MS);
      await update.tick();
      world.head = NEWER;
      // A build newer than the staged one finished: it is fetched and compared (the head itself is
      // compared by another answer).
      world.stage = () => Promise.resolve({ ...STAGED_OK, commit: 'e'.repeat(40) });
      world.stagedAhead = new Error('offline');
      return update;
    }

    it('ends the drain when the build fetched for a newer head cannot be compared: nothing is left to install', async () => {
      const update = await drainedThenLostNewBuild();
      expect(await update.tick()).toBe('unreachable');
      expect(update.status().draining).toBe(false);
      expect(world.calls).toContain('undrain');
    });

    it('keeps the time the update has waited through that, and drains again at once with the next build', async () => {
      const stagedAt = clock.now();
      const update = await drainedThenLostNewBuild();
      await update.tick();
      expect(update.status().waitingSince).toEqual(stagedAt);
      world.stagedAhead = true;
      expect(await update.tick()).toBe('draining');
      expect(update.status().waitingSince).toEqual(stagedAt);
    });
  });

  describe('when looking for a newer build fails with a build staged', () => {
    /** NEW is staged while the head, NEWER, builds; the next stage fails at `step`, keeping NEW. */
    async function stagedThenFailsAt(step: string) {
      world.head = NEWER;
      world.busy = 1;
      const update = make();
      expect(await update.tick()).toBe('busy');
      world.stage = () => Promise.resolve({ ok: false, step, message: 'gh: 502', kept: true });
      return update;
    }

    it.each(['find-commit', 'find-build'])(
      'installs the staged build, as with no GitHub at all, when the stage fails at %s',
      async (step) => {
        const update = await stagedThenFailsAt(step);
        world.busy = 0;
        expect(await update.tick()).toBe('applying');
        expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toEqual({
          head: NEWER,
          commit: NEW,
        });
        expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBeUndefined();
        expect(cards()).toEqual([]);
      },
    );

    it('leaves the drain on, and goes on looking, when main moved and the look failed', async () => {
      const update = await stagedThenFailsAt('find-build');
      clock.advance(WAIT_LIMIT_MS);
      expect(await update.tick()).toBe('draining');
      world.head = 'e'.repeat(40);
      expect(await update.tick()).toBe('draining');
      expect(world.calls).not.toContain('undrain');
      expect(world.stagedKeeping).toEqual([null, NEW]);
      expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBeUndefined();
      world.stage = () => Promise.resolve(STAGED_OK);
      world.head = 'f'.repeat(40);
      expect(await update.tick()).toBe('draining');
      expect(world.stagedKeeping).toEqual([null, NEW, NEW]);
    });

    it.each(['download', 'verify-checksum', 'stage'])(
      'installs the staged build when fetching it again fails at %s with main unchanged, and records no failure',
      async (step) => {
        // NEW is staged for NEWER while lanes run; nothing is mid-session when the re-stage fails.
        const update = await stagedThenFailsAt(step);
        world.busy = 0;
        expect(await update.tick()).toBe('applying');
        expect(world.stagedKeeping).toEqual([null, NEW]);
        expect(world.calls).toContain('apply');
        expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toEqual({
          head: NEWER,
          commit: NEW,
        });
        expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBeUndefined();
        expect(cards()).toEqual([]);
        expect(update.status().problem).toBeNull();
      },
    );

    /** NEW is staged for NEWER, then main moves on to a head whose newer build fails at `step`. */
    async function stagedThenNewerHeadFailsAt(step: string) {
      const update = await stagedThenFailsAt(step);
      world.head = 'e'.repeat(40);
      return update;
    }

    it.each(['download', 'verify-checksum'])(
      'does not install the older build when the build for a newer head failed at %s, and raises one card',
      async (step) => {
        const update = await stagedThenNewerHeadFailsAt(step);
        world.busy = 0;
        expect(await update.tick()).toBe('failed');
        expect(await update.tick()).toBe('failed-before');
        expect(world.calls).not.toContain('apply');
        expect(cards()).toHaveLength(1);
        expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBe('e'.repeat(40));
      },
    );

    it('keeps the staged build for the next look once a newer one failed to fetch', async () => {
      const update = await stagedThenNewerHeadFailsAt('download');
      world.busy = 0;
      await update.tick();
      // Main moves on and the newest finished build turns out to be the staged one after all.
      world.head = 'f'.repeat(40);
      world.stage = () => Promise.resolve(STAGED_OK);
      expect(await update.tick()).toBe('applying');
      expect(world.stagedKeeping).toEqual([null, NEW, NEW]);
    });

    it('forgets the kept build when the builder retries through the switch, off and then on', async () => {
      const update = await stagedThenNewerHeadFailsAt('download');
      world.busy = 0;
      expect(await update.tick()).toBe('failed');
      // The route setSelfUpdate takes: retry() on every touch, then turnOff() when it goes off.
      world.enabled = false;
      update.retry();
      await update.turnOff();
      world.enabled = true;
      update.retry();
      world.stage = () =>
        Promise.resolve({ ok: true, current: false, dir: STAGED.dir, commit: NEWER });
      expect(await update.tick()).toBe('applying');
      // Nothing is kept, so the next stage is not passed --have.
      expect(world.stagedKeeping).toEqual([null, NEW, null]);
    });

    it('tries the build that failed to fetch again, keeping the staged one, on retry() alone', async () => {
      const update = await stagedThenNewerHeadFailsAt('download');
      world.busy = 0;
      await update.tick();
      update.retry();
      world.stage = () =>
        Promise.resolve({ ok: true, current: false, dir: STAGED.dir, commit: NEWER });
      expect(await update.tick()).toBe('applying');
      expect(world.stagedKeeping).toEqual([null, NEW, NEW]);
      expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toEqual({
        head: 'e'.repeat(40),
        commit: NEWER,
      });
    });

    it.each(['download', 'verify-checksum', 'stage'])(
      'does not install the older build when the build for the same head fails again at %s after retry()',
      async (step) => {
        const update = await stagedThenNewerHeadFailsAt('download');
        world.busy = 0;
        expect(await update.tick()).toBe('failed');
        update.retry();
        expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBeUndefined();
        world.stage = () => Promise.resolve({ ok: false, step, message: 'gh: 502', kept: true });
        expect(await update.tick()).toBe('failed');
        expect(world.calls).not.toContain('apply');
        expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBe('e'.repeat(40));
        expect(cards()).toHaveLength(1);
        expect(update.status().notInstalling).toBe('failed');
        expect(await update.tick()).toBe('failed-before');
        expect(world.calls).not.toContain('apply');
      },
    );

    /** The newer build failed and the builder retried, so only the mark says it failed. */
    async function retriedAfterNewerHeadFailed() {
      const update = await stagedThenNewerHeadFailsAt('download');
      world.busy = 0;
      expect(await update.tick()).toBe('failed');
      update.retry();
      expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBeUndefined();
      return update;
    }

    it('does not install the older build when GitHub goes away after retry()', async () => {
      const update = await retriedAfterNewerHeadFailed();
      world.head = new Error('offline');
      expect(await update.tick()).toBe('unreachable');
      expect(world.calls).not.toContain('apply');
      expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBeUndefined();
    });

    it.each(['find-commit', 'find-build'])(
      'does not install the older build when the look fails at %s after retry(), and records nothing',
      async (step) => {
        const update = await retriedAfterNewerHeadFailed();
        world.stage = () => Promise.resolve({ ok: false, step, message: 'gh: 502', kept: true });
        expect(await update.tick()).toBe('unreachable');
        expect(world.stagedKeeping).toEqual([null, NEW, NEW]);
        expect(world.calls).not.toContain('apply');
        expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBeUndefined();
      },
    );

    it('does not fall back on the older build when GitHub goes away after a newer one failed', async () => {
      // The head moved first, so the staged build was found for an earlier head than the failure.
      world.busy = 1;
      const update = make();
      await update.tick();
      world.head = NEWER;
      world.stage = () =>
        Promise.resolve({ ok: false, step: 'download', message: 'gh: 502', kept: true });
      expect(await update.tick()).toBe('failed');
      world.busy = 0;
      world.head = new Error('offline');
      expect(await update.tick()).toBe('unreachable');
      expect(world.calls).not.toContain('apply');
    });

    it('forgets the staged build when the failed stage says it is gone', async () => {
      const update = await stagedThenFailsAt('find-build');
      world.stage = () => Promise.resolve({ ok: false, step: 'find-build', message: 'gh: 502' });
      expect(await update.tick()).toBe('busy');
      world.busy = 0;
      expect(await update.tick()).toBe('failed');
      world.head = 'e'.repeat(40);
      world.stage = () => Promise.resolve(STAGED_OK);
      await update.tick();
      expect(world.stagedKeeping.at(-1)).toBeNull();
    });

    it('forgets the staged build when the stage finds the running build is the newest', async () => {
      const update = await stagedThenFailsAt('find-build');
      world.busy = 0;
      world.stage = () => Promise.resolve({ ok: true, current: true, commit: RUNNING });
      expect(await update.tick()).toBe('no-newer-build');
      expect(await update.tick()).toBe('no-newer-build');
      expect(world.stagedKeeping).toEqual([null, NEW, null]);
      expect(world.calls).not.toContain('apply');
    });

    it('forgets the staged build when the switch goes off during the look', async () => {
      const update = await stagedThenFailsAt('find-build');
      world.busy = 0;
      world.stage = () => {
        world.enabled = false;
        return Promise.resolve({ ok: false, step: 'stage', message: 'stopped' });
      };
      expect(await update.tick()).toBe('off');
      world.enabled = true;
      world.stage = () => Promise.resolve(STAGED_OK);
      await update.tick();
      expect(world.stagedKeeping).toEqual([null, NEW, null]);
    });
  });

  describe('Install Now', () => {
    it('drains at once, though the update has waited no time', async () => {
      world.busy = 3;
      const update = make();
      await update.tick();
      const drainStart = clock.now();
      update.installNow();
      expect(world.calls).toEqual(['stage', 'drain']);
      expect(update.status().drainingSince).toEqual(drainStart);
      // The check it starts finds the drain on and the work still running.
      await settled();
      expect(world.calls).toEqual(['stage', 'drain']);
    });

    it('installs on the check it starts when the running steps have finished', async () => {
      world.busy = 3;
      const update = make();
      await update.tick();
      world.busy = 0;
      update.installNow();
      await waitFor(() => world.calls.includes('apply'));
      expect(world.calls).toEqual(['stage', 'pause', 'apply']);
    });

    it('does nothing when there is no update', async () => {
      world.head = RUNNING;
      const update = make();
      await update.tick();
      update.installNow();
      expect(world.calls).toEqual([]);
      expect(update.status().draining).toBe(false);
    });

    it('drains as soon as the build is staged when it was asked for before', async () => {
      world.busy = 3;
      let finish: (result: StageResult) => void = () => undefined;
      world.stage = () =>
        new Promise<StageResult>((resolve) => {
          finish = resolve;
        });
      const update = make();
      const first = update.tick();
      await waitFor(() => world.calls.includes('stage'));
      // An update is known to be available (main is ahead) but still being fetched.
      update.installNow();
      expect(world.calls).toEqual(['stage']);
      finish(STAGED_OK);
      expect(await first).toBe('draining');
    });

    const NOT_YET: readonly (readonly [string, () => void])[] = [
      [
        'the newest finished build is the one that runs',
        () => {
          world.stage = () => Promise.resolve({ ok: true, current: true, commit: RUNNING });
        },
      ],
      [
        'the newest finished build is not ahead of the running one',
        () => {
          world.stage = () => Promise.resolve({ ...STAGED_OK, commit: OLD_BUILD });
          world.stagedAhead = false;
        },
      ],
      [
        'the newest finished build is the one the builder rolled back from, and the stage skipped it',
        () => {
          world.rolledBackFrom = OLD_BUILD;
          world.stage = () => Promise.resolve({ ok: true, current: true, commit: OLD_BUILD });
        },
      ],
      [
        'the newest finished build is the one the builder rolled back from, and the stage fetched it',
        () => {
          world.rolledBackFrom = OLD_BUILD;
          world.stage = () => Promise.resolve({ ...STAGED_OK, commit: OLD_BUILD });
        },
      ],
    ];

    it.each(NOT_YET)('is remembered while %s', async (_name, noBuildYet) => {
      world.busy = 3;
      noBuildYet();
      const update = make();
      update.settle();
      await update.tick();
      expect(update.status().availableCommit).toBe(NEW);
      update.installNow();
      await settled();
      expect(update.status().draining).toBe(false);
      // The build is staged at last: the update has waited no time, yet the factory drains.
      world.stage = () => Promise.resolve(STAGED_OK);
      world.stagedAhead = true;
      expect(await update.tick()).toBe('draining');
    });

    it('is forgotten when main is back at the running commit', async () => {
      world.busy = 3;
      const update = make();
      await update.tick();
      update.installNow();
      await settled();
      world.head = RUNNING;
      expect(await update.tick()).toBe('current');
      world.head = NEW;
      expect(await update.tick()).toBe('busy');
      expect(update.status().draining).toBe(false);
    });

    it('is forgotten when the switch is turned off', async () => {
      world.busy = 3;
      const update = make();
      await update.tick();
      update.installNow();
      world.enabled = false;
      await update.turnOff();
      await settled();
      world.enabled = true;
      expect(await update.tick()).toBe('busy');
      expect(update.status().draining).toBe(false);
    });
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

  it('names the switch by its label in Settings', async () => {
    await make().tick();
    expect(cards()[0]?.body).toContain('turn Update 10db by itself off and on in Settings');
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

describe('turning the switch off', () => {
  it('installs nothing from a stage that ends after the switch was turned off', async () => {
    let finish: (result: StageResult) => void = () => undefined;
    world.stage = () =>
      new Promise<StageResult>((resolve) => {
        finish = resolve;
      });
    const update = make();
    const check = update.tick();
    await waitFor(() => world.calls.includes('stage'));
    world.enabled = false;
    finish(STAGED_OK);
    expect(await check).toBe('off');
    expect(world.calls).not.toContain('apply');
    expect(world.calls).not.toContain('pause');
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toBeUndefined();
    expect(cards()).toEqual([]);
  });

  it('lets work go on and installs nothing when the switch is turned off while work is held back', async () => {
    let settle: () => void = () => undefined;
    world.pause = () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      });
    const check = make().tick();
    await waitFor(() => world.calls.includes('pause'));
    world.enabled = false;
    settle();
    expect(await check).toBe('off');
    expect(world.calls).toEqual(['stage', 'pause', 'resume']);
    expect(getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY)).toBeUndefined();
  });

  it('kills a stage under way, with no card, and stages again once it is back on', async () => {
    let finish: (result: StageResult) => void = () => undefined;
    world.stage = () =>
      new Promise<StageResult>((resolve) => {
        finish = resolve;
      });
    world.cancelStage = () => {
      world.enabled = false;
      finish({ ok: false, step: 'stage', message: 'killed' });
      return Promise.resolve();
    };
    const update = make();
    const check = update.tick();
    await waitFor(() => world.calls.includes('stage'));
    await update.turnOff();
    expect(await check).toBe('off');
    expect(world.calls).toEqual(['stage', 'cancel-stage']);
    expect(cards()).toEqual([]);
    expect(getAppSetting(state.db, SELF_UPDATE_FAILED_KEY)).toBeUndefined();

    world.enabled = true;
    world.stage = () => Promise.resolve(STAGED_OK);
    expect(await update.tick()).toBe('applying');
  });

  it('forgets a build staged before it was turned off, so turning it on fetches afresh', async () => {
    world.busy = 1;
    const update = make();
    expect(await update.tick()).toBe('busy');
    await update.turnOff();
    world.busy = 0;
    expect(await update.tick()).toBe('applying');
    expect(world.calls.filter((call) => call === 'stage')).toHaveLength(2);
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

  it('keeps it across restarts: the record is in the database, not the marker file', async () => {
    rolledBack();
    expect(world.rolledBackFrom).toBeNull();
    const next = make();
    next.settle();
    expect(await next.tick()).toBe('rolled-back');
  });

  it('tells the stage not to fetch the rolled-back build, and looks again next time', async () => {
    world.head = NEWER;
    // The newest finished build of main is still the one rolled back from: nothing was fetched.
    world.stage = () => Promise.resolve({ ok: true, current: true, commit: NEW });
    const update = rolledBack();
    expect(await update.tick()).toBe('no-newer-build');
    expect(await update.tick()).toBe('no-newer-build');
    expect(world.stagedSkipping).toEqual([NEW, NEW]);
    expect(world.calls).not.toContain('apply');
  });

  it('installs the head’s build once it finishes, after a stage that found only the rolled-back one', async () => {
    world.head = NEWER;
    // A stage that fetched the rolled-back build anyway is dropped, so the next check looks again.
    world.stage = () => Promise.resolve(STAGED_OK);
    const update = rolledBack();
    expect(await update.tick()).toBe('no-newer-build');
    expect(world.calls).not.toContain('apply');
    world.stage = () =>
      Promise.resolve({ ok: true, current: false, dir: STAGED.dir, commit: NEWER });
    expect(await update.tick()).toBe('applying');
  });

  it('installs the head’s build once it finishes, after a stage that skipped the rolled-back one', async () => {
    world.head = NEWER;
    world.stage = () => Promise.resolve({ ok: true, current: true, commit: NEW });
    const update = rolledBack();
    expect(await update.tick()).toBe('no-newer-build');
    world.stage = () =>
      Promise.resolve({ ok: true, current: false, dir: STAGED.dir, commit: NEWER });
    expect(await update.tick()).toBe('applying');
  });

  it('installs a newer build of main once one finishes', async () => {
    world.head = NEWER;
    world.stage = () =>
      Promise.resolve({ ok: true, current: false, dir: STAGED.dir, commit: NEWER });
    const update = rolledBack();
    expect(await update.tick()).toBe('applying');
  });

  it('installs the rolled-back build again once the builder touches the switch', async () => {
    const update = rolledBack();
    update.retry();
    expect(await update.tick()).toBe('applying');
  });

  it('ignores a marker naming the commit that runs: the builder rolled back to it again', async () => {
    world.rolledBackFrom = RUNNING;
    const update = make();
    update.settle();
    expect(world.rolledBackFrom).toBeNull();
    expect(await update.tick()).toBe('applying');
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

describe('why an available update is not installing', () => {
  it('says nothing is held back while the update waits or installs', async () => {
    const update = make();
    expect(update.status().notInstalling).toBeNull();
    world.busy = 1;
    expect(await update.tick()).toBe('busy');
    expect(update.status().notInstalling).toBeNull();
  });

  it('says the update failed, also after a restart and with no project for a card', async () => {
    world.stage = () => Promise.resolve({ ok: false, step: 'download', message: 'reset' });
    const update = make({ cardProject: null });
    expect(await update.tick()).toBe('failed');
    expect(update.status().notInstalling).toBe('failed');
    expect(await update.tick()).toBe('failed-before');
    expect(update.status().notInstalling).toBe('failed');
    const restarted = make();
    expect(await restarted.tick()).toBe('failed-before');
    expect(restarted.status().notInstalling).toBe('failed');
  });

  it('says the builder rolled back from the head, until main moves on', async () => {
    world.rolledBackFrom = NEW;
    const update = make();
    update.settle();
    expect(await update.tick()).toBe('rolled-back');
    expect(update.status().notInstalling).toBe('rolled-back');
    world.head = NEWER;
    world.stage = () =>
      Promise.resolve({ ok: true, current: false, dir: STAGED.dir, commit: NEWER });
    expect(await update.tick()).toBe('applying');
    expect(update.status().notInstalling).toBeNull();
  });

  it('says the head has no finished build newer than the running one', async () => {
    world.stage = () => Promise.resolve({ ok: true, current: true, commit: RUNNING });
    const update = make();
    expect(await update.tick()).toBe('no-newer-build');
    expect(update.status().notInstalling).toBe('unbuilt');
    world.stage = () => Promise.resolve(STAGED_OK);
    expect(await update.tick()).toBe('applying');
    expect(update.status().notInstalling).toBeNull();
  });

  it('forgets it once main is the running commit', async () => {
    world.stage = () => Promise.resolve({ ok: true, current: true, commit: RUNNING });
    const update = make();
    await update.tick();
    expect(update.status().notInstalling).toBe('unbuilt');
    world.head = RUNNING;
    expect(await update.tick()).toBe('current');
    expect(update.status().notInstalling).toBeNull();
  });

  it.each<[string, () => void, string]>([
    [
      'a failed head',
      () => {
        world.stage = () => Promise.resolve({ ok: false, step: 'download', message: 'reset' });
      },
      'failed',
    ],
    [
      'a head rolled back from',
      () => {
        world.rolledBackFrom = NEW;
      },
      'rolled-back',
    ],
  ])('forgets %s at once when the builder asks again', async (_name, arrange, reason) => {
    arrange();
    const update = make();
    update.settle();
    await update.tick();
    expect(update.status().notInstalling).toBe(reason);
    update.retry();
    // No check has ended yet: the switch is the builder's answer to the line, so the line goes now.
    expect(update.status().notInstalling).toBeNull();
  });

  it.each<[string, () => void]>([
    [
      'skipped',
      () => {
        world.stage = () => Promise.resolve({ ok: true, current: true, commit: OLD_BUILD });
      },
    ],
    [
      'fetched',
      () => {
        world.stage = () => Promise.resolve({ ...STAGED_OK, commit: OLD_BUILD });
      },
    ],
  ])(
    'says a head has no build, not that it was rolled back from, when only the rolled-back build exists and the stage %s it',
    async (_name, arrange) => {
      world.rolledBackFrom = OLD_BUILD;
      arrange();
      const update = make();
      update.settle();
      expect(await update.tick()).toBe('no-newer-build');
      expect(update.status().availableCommit).toBe(NEW);
      expect(update.status().notInstalling).toBe('unbuilt');
    },
  );

  describe('when GitHub cannot be reached', () => {
    const offline = new Error('gh is signed out');

    it.each<[string, () => void, string]>([
      [
        'rolled-back',
        () => {
          world.rolledBackFrom = NEW;
        },
        'rolled-back',
      ],
      [
        'unbuilt',
        () => {
          world.stage = () => Promise.resolve({ ok: true, current: true, commit: RUNNING });
        },
        'unbuilt',
      ],
    ])('keeps saying %s when the head cannot be read', async (_name, arrange, reason) => {
      arrange();
      const update = make();
      update.settle();
      await update.tick();
      world.head = offline;
      expect(await update.tick()).toBe('unreachable');
      expect(update.status().availableCommit).toBe(NEW);
      expect(update.status().notInstalling).toBe(reason);
    });

    it('keeps the reason when main cannot be compared with the running build', async () => {
      world.rolledBackFrom = NEW;
      const update = make();
      update.settle();
      await update.tick();
      world.ahead = offline;
      expect(await update.tick()).toBe('unreachable');
      expect(update.status().notInstalling).toBe('rolled-back');
    });

    it('says failed for an install that ended while the daemon ran, then GitHub went', async () => {
      const update = make();
      expect(await update.tick()).toBe('applying');
      world.head = offline;
      world.endScript();
      await settled();
      expect(await update.tick()).toBe('unreachable');
      expect(update.status().availableCommit).toBe(NEW);
      expect(update.status().notInstalling).toBe('failed');
    });
  });

  it('says failed as soon as an install ends while the daemon runs, before the next check', async () => {
    const update = make();
    expect(await update.tick()).toBe('applying');
    expect(update.status().notInstalling).toBeNull();
    world.endScript();
    await settled();
    expect(update.status().notInstalling).toBe('failed');
  });

  it.each<[string, () => void]>([
    [
      'failed',
      () => {
        world.stage = () => Promise.resolve({ ok: false, step: 'download', message: 'reset' });
      },
    ],
    [
      'was rolled back from',
      () => {
        world.rolledBackFrom = NEW;
      },
    ],
    [
      'had no build',
      () => {
        world.stage = () => Promise.resolve({ ok: true, current: true, commit: RUNNING });
      },
    ],
  ])('says nothing of the old head while a new one stages after it %s', async (_name, arrange) => {
    arrange();
    const update = make();
    update.settle();
    await update.tick();
    expect(update.status().notInstalling).not.toBeNull();
    world.head = NEWER;
    let finishStage: (result: StageResult) => void = () => undefined;
    world.stage = () =>
      new Promise((resolve) => {
        finishStage = resolve;
      });
    const tick = update.tick();
    await settled();
    expect(update.status().availableCommit).toBe(NEWER);
    // Nothing of the old head's, but not idle-waiting either: its build is being fetched.
    expect(update.status().notInstalling).toBe('fetching');
    finishStage({ ok: true, current: true, commit: RUNNING });
    expect(await tick).toBe('no-newer-build');
    expect(update.status().notInstalling).toBe('unbuilt');
  });

  describe('while the first build of a head is fetched or waited for', () => {
    let finishStage: (result: StageResult) => void = () => undefined;
    beforeEach(() => {
      world.stage = () =>
        new Promise((resolve) => {
          finishStage = resolve;
        });
    });

    it('says it is fetching, with nothing staged and nothing waiting', async () => {
      const update = make();
      const tick = update.tick();
      await settled();
      expect(update.status().availableCommit).toBe(NEW);
      expect(update.status().waitingSince).toBeNull();
      expect(update.status().notInstalling).toBe('fetching');
      finishStage(STAGED_OK);
      expect(await tick).toBe('applying');
      expect(update.status().notInstalling).toBeNull();
    });

    it('says it again for a stage that fails, not that it waits', async () => {
      const update = make();
      const tick = update.tick();
      await settled();
      expect(update.status().notInstalling).toBe('fetching');
      finishStage({ ok: false, step: 'download', message: 'reset' });
      expect(await tick).toBe('failed');
      expect(update.status().notInstalling).toBe('failed');
    });

    it('says it no more once the build is staged and waits for an idle moment', async () => {
      world.busy = 1;
      const update = make();
      const tick = update.tick();
      await settled();
      finishStage(STAGED_OK);
      expect(await tick).toBe('busy');
      expect(update.status().waitingSince).not.toBeNull();
      expect(update.status().notInstalling).toBeNull();
    });

    it('says nothing of it when the switch is off', async () => {
      const update = make();
      const tick = update.tick();
      await settled();
      world.enabled = false;
      expect(update.status().notInstalling).toBeNull();
      finishStage(STAGED_OK);
      await tick;
    });
  });

  it('keeps the head’s reason through a stage for the same head', async () => {
    world.stage = () => Promise.resolve({ ok: true, current: true, commit: RUNNING });
    const update = make();
    await update.tick();
    let finishStage: (result: StageResult) => void = () => undefined;
    world.stage = () =>
      new Promise((resolve) => {
        finishStage = resolve;
      });
    const tick = update.tick();
    await settled();
    expect(update.status().notInstalling).toBe('unbuilt');
    finishStage({ ok: true, current: true, commit: RUNNING });
    await tick;
  });
});
