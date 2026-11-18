import type { ProjectId, ShapeId } from '@10db/contracts';
import { createTestStore, getAppSetting, listInbox, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger, type Logger } from '../log';
import { createStatusService, type StatusService } from '../status';
import {
  createSelfUpdate,
  DRAIN_LIMIT_MS,
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
<<<<<<< e2fefcda51952d923f80c28e5a5d17bcc4a3e52e
||||||| 13c88665

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

  it('does not call the machine offline for a certificate failure, and quotes gh', async () => {
    for (const text of [
      'gh api failed (exit 1): Get "https://api.github.com/repos/o/r": tls: failed to verify certificate: x509: certificate signed by unknown authority',
      'gh api failed (exit 1): Get "https://api.github.com/repos/o/r": x509: certificate has expired or is not yet valid',
    ]) {
      world.head = new GhError(GhFailure.Unreachable, text);
      const update = make();
      expect(await update.tick()).toBe('unreachable');
      const message = update.status().problem?.message ?? '';
      expect(message).toMatch(/could not reach GitHub securely/i);
      expect(message).toContain(text);
      expect(message).not.toMatch(/offline/i);
    }
  });

  it('does not call the machine offline for a connection cut off with EOF, and quotes gh', async () => {
    for (const text of [
      'gh api failed (exit 1): EOF',
      'gh api failed (exit 1): Get "https://api.github.com/repos/o/r/compare/a...b": EOF',
    ]) {
      world.head = new GhError(GhFailure.Unreachable, text);
      const update = make();
      expect(await update.tick()).toBe('unreachable');
      const message = update.status().problem?.message ?? '';
      expect(message).toMatch(/lost its connection to GitHub/i);
      expect(message).toContain(text);
      expect(message).not.toMatch(/offline/i);
    }
  });

  it('gives a signed-out gh, an offline machine and an error GitHub answered each their own reason', async () => {
    const reasons: string[] = [];
    for (const error of [
      new GhError(
        GhFailure.SignedOut,
        'gh is not signed in. Sign in to GitHub in Settings › Integrations.',
      ),
      new GhError(GhFailure.Unreachable, 'gh api failed (exit 1): error connecting to github.com'),
      new GhError(GhFailure.Failed, 'gh api failed (exit 1): gh: Not Found (HTTP 404)'),
    ]) {
      world.head = error;
      const update = make();
      expect(await update.tick()).toBe('unreachable');
      reasons.push(update.status().problem?.message ?? '');
    }
    expect(reasons[0]).toMatch(/signed out/i);
    expect(reasons[0]).toContain('Sign in to GitHub in Settings › Integrations.');
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

  it('does not say the update waits for an idle moment when a stage left nothing staged and GitHub cannot compare it', async () => {
    world.stage = () => Promise.resolve({ ...STAGED_OK, commit: 'e'.repeat(40) });
    world.stagedAhead = new Error('offline');
    const update = make();
    expect(await update.tick()).toBe('unreachable');
    const status = update.status();
    expect(status.availableCommit).toBe(NEW);
    expect(status.problem?.kind).toBe('unreachable');
    expect(status.waitingSince).toBeNull();
    // No check runs, so nothing is being fetched: nothing is staged and GitHub has to answer first.
    expect(status.notInstalling).toBe('unreachable');
  });

  it('says the same when GitHub then stops answering for the head too', async () => {
    world.stage = () => Promise.resolve({ ...STAGED_OK, commit: 'e'.repeat(40) });
    world.stagedAhead = new Error('offline');
    const update = make();
    expect(await update.tick()).toBe('unreachable');
    world.head = new Error('offline');
    expect(await update.tick()).toBe('unreachable');
    expect(update.status().notInstalling).toBe('unreachable');
  });
});

describe('a drain that only shaping conversations hold', () => {
  const DENSER = { id: mintId('Shape'), title: 'Denser board' };
  const shapeLines = () => statusService.current().lines;
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

  /** Past the alert, then past the status line's own 2 minutes. */
  async function shown(update: SelfUpdate) {
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    clock.advance(STATUS_HYSTERESIS_MS);
  }

  it('says nothing at first: a turn is expected to end on its own', async () => {
    await (await drainingForShapes(DENSER)).tick();
    clock.advance(STATUS_HYSTERESIS_MS);
    expect(shapeLines()).toEqual([]);
  });

  it('shows one status line, and no card, naming the conversation that keeps lanes paused past the limit', async () => {
    const update = await drainingForShapes(DENSER);
    await shown(update);
    const [line, ...rest] = shapeLines();
    expect(rest).toEqual([]);
    expect(line?.kind).toBe('update_hold');
    expect(line?.line).toContain('“Denser board”');
    expect(line?.details).toContain('“Denser board”');
    expect(line?.details).toContain('press Stop');
    // Stop only interrupts: a session that ignores it needs a way out that does not depend on it.
    expect(line?.details).toContain(`turn ${SELF_UPDATE_SWITCH} off`);
    expect(line?.details).toContain('quit 10db');
    expect(shapeCards()).toEqual([]);
  });

  it('names every conversation that holds it, then only those still holding it', async () => {
    const login = { id: mintId('Shape'), title: 'Login flow' };
    const update = await drainingForShapes(DENSER, login);
    await shown(update);
    expect(shapeLines()[0]?.details).toMatch(/“Denser board”.*“Login flow”/);
    world.busy = 1;
    world.shapes = [login];
    await update.tick();
    expect(shapeLines()).toHaveLength(1);
    expect(shapeLines()[0]?.details).toContain('“Login flow”');
    expect(shapeLines()[0]?.details).not.toContain('“Denser board”');
  });

  it('shows none while a lane or gate also holds the drain', async () => {
    const update = await drainingForShapes(DENSER);
    world.busy = 2;
    await shown(update);
    expect(shapeLines()).toEqual([]);
  });

  it('does not count the time a lane held it before the conversation was the only holder', async () => {
    world.busy = 2;
    world.shapes = [DENSER];
    world.waitLimitMs = 0;
    const update = make();
    await update.tick();
    await shown(update);
    expect(shapeLines()).toEqual([]);
    world.busy = 1;
    await update.tick();
    clock.advance(STATUS_HYSTERESIS_MS);
    expect(shapeLines()).toEqual([]);
  });

  it('lets the line go once the turn ends and the install can go on', async () => {
    const update = await drainingForShapes(DENSER);
    await shown(update);
    expect(shapeLines()).toHaveLength(1);
    world.busy = 0;
    world.shapes = [];
    expect(await update.tick()).toBe('applying');
    clock.advance(STATUS_HYSTERESIS_MS);
    expect(shapeLines()).toEqual([]);
  });

  it('lets the line go when the drain ends for another reason', async () => {
    const update = await drainingForShapes(DENSER);
    await shown(update);
    await update.turnOff();
    clock.advance(STATUS_HYSTERESIS_MS);
    expect(shapeLines()).toEqual([]);
  });

  describe('after a restart', () => {
    /** A card an earlier version left open, on `project`: nothing in this run holds it. */
    function cardLeftOpen(project: ProjectId) {
      createInboxService({ state, onParkedAnswer: () => undefined }).flag({
        tier: 'ask',
        urgency: 'high',
        closesWhen: { by: 'answer' },
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

    it.each(['find-commit', 'find-build'])(
      'does not say a build staged for the failed head waits for an idle moment when main moves and the look fails at %s',
      async (step) => {
        world.busy = 1;
        const update = make();
        await update.tick();
        world.busy = 0;
        world.apply = () => ({ ok: false, step: 'start-install', message: 'spawn bash ENOENT' });
        expect(await update.tick()).toBe('failed');
        // The new head clears the failure, so only the staged build's head says it is held back.
        world.head = NEWER;
        world.stage = () => Promise.resolve({ ok: false, step, message: 'gh: 502', kept: true });
        expect(await update.tick()).toBe('unreachable');
        expect(world.calls.filter((call) => call === 'apply')).toEqual(['apply']);
        const status = update.status();
        expect(status.availableCommit).toBe(NEWER);
        expect(status.problem?.kind).toBe('unreachable');
        expect(status.notInstalling).toBe('unreachable');
      },
    );

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

    it('does not say the held-back build waits for an idle moment when GitHub goes away after retry()', async () => {
      const update = await retriedAfterNewerHeadFailed();
      world.head = new Error('offline');
      expect(await update.tick()).toBe('unreachable');
      const status = update.status();
      expect(status.availableCommit).toBe('e'.repeat(40));
      expect(status.problem?.kind).toBe('unreachable');
      expect(status.notInstalling).toBe('unreachable');
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

    it.each(['find-commit', 'find-build'])(
      'does not say the held-back build waits for an idle moment when the look fails at %s after retry()',
      async (step) => {
        const update = await retriedAfterNewerHeadFailed();
        world.stage = () => Promise.resolve({ ok: false, step, message: 'gh: 502', kept: true });
        expect(await update.tick()).toBe('unreachable');
        const status = update.status();
        expect(status.availableCommit).toBe('e'.repeat(40));
        expect(status.problem?.kind).toBe('unreachable');
        expect(status.notInstalling).toBe('unreachable');
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
=======

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

  it('does not call the machine offline for a certificate failure, and quotes gh', async () => {
    for (const text of [
      'gh api failed (exit 1): Get "https://api.github.com/repos/o/r": tls: failed to verify certificate: x509: certificate signed by unknown authority',
      'gh api failed (exit 1): Get "https://api.github.com/repos/o/r": x509: certificate has expired or is not yet valid',
    ]) {
      world.head = new GhError(GhFailure.Unreachable, text);
      const update = make();
      expect(await update.tick()).toBe('unreachable');
      const message = update.status().problem?.message ?? '';
      expect(message).toMatch(/could not reach GitHub securely/i);
      expect(message).toContain(text);
      expect(message).not.toMatch(/offline/i);
    }
  });

  it('does not call the machine offline for a connection cut off with EOF, and quotes gh', async () => {
    for (const text of [
      'gh api failed (exit 1): EOF',
      'gh api failed (exit 1): Get "https://api.github.com/repos/o/r/compare/a...b": EOF',
    ]) {
      world.head = new GhError(GhFailure.Unreachable, text);
      const update = make();
      expect(await update.tick()).toBe('unreachable');
      const message = update.status().problem?.message ?? '';
      expect(message).toMatch(/lost its connection to GitHub/i);
      expect(message).toContain(text);
      expect(message).not.toMatch(/offline/i);
    }
  });

  it('gives a signed-out gh, an offline machine and an error GitHub answered each their own reason', async () => {
    const reasons: string[] = [];
    for (const error of [
      new GhError(
        GhFailure.SignedOut,
        'gh is not signed in. Sign in to GitHub in Settings › Integrations.',
      ),
      new GhError(GhFailure.Unreachable, 'gh api failed (exit 1): error connecting to github.com'),
      new GhError(GhFailure.Failed, 'gh api failed (exit 1): gh: Not Found (HTTP 404)'),
    ]) {
      world.head = error;
      const update = make();
      expect(await update.tick()).toBe('unreachable');
      reasons.push(update.status().problem?.message ?? '');
    }
    expect(reasons[0]).toMatch(/signed out/i);
    expect(reasons[0]).toContain('Sign in to GitHub in Settings › Integrations.');
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

  it('does not say the update waits for an idle moment when a stage left nothing staged and GitHub cannot compare it', async () => {
    world.stage = () => Promise.resolve({ ...STAGED_OK, commit: 'e'.repeat(40) });
    world.stagedAhead = new Error('offline');
    const update = make();
    expect(await update.tick()).toBe('unreachable');
    const status = update.status();
    expect(status.availableCommit).toBe(NEW);
    expect(status.problem?.kind).toBe('unreachable');
    expect(status.waitingSince).toBeNull();
    // No check runs, so nothing is being fetched: nothing is staged and GitHub has to answer first.
    expect(status.notInstalling).toBe('unreachable');
  });

  it('says the same when GitHub then stops answering for the head too', async () => {
    world.stage = () => Promise.resolve({ ...STAGED_OK, commit: 'e'.repeat(40) });
    world.stagedAhead = new Error('offline');
    const update = make();
    expect(await update.tick()).toBe('unreachable');
    world.head = new Error('offline');
    expect(await update.tick()).toBe('unreachable');
    expect(update.status().notInstalling).toBe('unreachable');
  });
});

describe('a drain that only shaping conversations hold', () => {
  const DENSER = { id: mintId('Shape'), title: 'Denser board' };
  const shapeLines = () => statusService.current().lines;
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

  /** Past the alert, then past the status line's own 2 minutes. */
  async function shown(update: SelfUpdate) {
    clock.advance(SHAPE_HOLD_ALERT_MS);
    await update.tick();
    clock.advance(STATUS_HYSTERESIS_MS);
  }

  it('says nothing at first: a turn is expected to end on its own', async () => {
    await (await drainingForShapes(DENSER)).tick();
    clock.advance(STATUS_HYSTERESIS_MS);
    expect(shapeLines()).toEqual([]);
  });

  it('shows one status line, and no card, naming the conversation that keeps lanes paused past the limit', async () => {
    const update = await drainingForShapes(DENSER);
    await shown(update);
    const [line, ...rest] = shapeLines();
    expect(rest).toEqual([]);
    expect(line?.kind).toBe('update_hold');
    expect(line?.line).toContain('“Denser board”');
    expect(line?.details).toContain('“Denser board”');
    expect(line?.details).toContain('press Stop');
    // Stop only interrupts: a session that ignores it needs a way out that does not depend on it.
    expect(line?.details).toContain(`turn ${SELF_UPDATE_SWITCH} off`);
    expect(line?.details).toContain('quit 10db');
    expect(shapeCards()).toEqual([]);
  });

  it('names every conversation that holds it, then only those still holding it', async () => {
    const login = { id: mintId('Shape'), title: 'Login flow' };
    const update = await drainingForShapes(DENSER, login);
    await shown(update);
    expect(shapeLines()[0]?.details).toMatch(/“Denser board”.*“Login flow”/);
    world.busy = 1;
    world.shapes = [login];
    await update.tick();
    expect(shapeLines()).toHaveLength(1);
    expect(shapeLines()[0]?.details).toContain('“Login flow”');
    expect(shapeLines()[0]?.details).not.toContain('“Denser board”');
  });

  it('shows none while a lane or gate also holds the drain', async () => {
    const update = await drainingForShapes(DENSER);
    world.busy = 2;
    await shown(update);
    expect(shapeLines()).toEqual([]);
  });

  it('does not count the time a lane held it before the conversation was the only holder', async () => {
    world.busy = 2;
    world.shapes = [DENSER];
    world.waitLimitMs = 0;
    const update = make();
    await update.tick();
    await shown(update);
    expect(shapeLines()).toEqual([]);
    world.busy = 1;
    await update.tick();
    clock.advance(STATUS_HYSTERESIS_MS);
    expect(shapeLines()).toEqual([]);
  });

  it('lets the line go once the turn ends and the install can go on', async () => {
    const update = await drainingForShapes(DENSER);
    await shown(update);
    expect(shapeLines()).toHaveLength(1);
    world.busy = 0;
    world.shapes = [];
    expect(await update.tick()).toBe('applying');
    clock.advance(STATUS_HYSTERESIS_MS);
    expect(shapeLines()).toEqual([]);
  });

  it('lets the line go when the drain ends for another reason', async () => {
    const update = await drainingForShapes(DENSER);
    await shown(update);
    await update.turnOff();
    clock.advance(STATUS_HYSTERESIS_MS);
    expect(shapeLines()).toEqual([]);
  });

  describe('after a restart', () => {
    /** A card an earlier version left open, on `project`: nothing in this run holds it. */
    function cardLeftOpen(project: ProjectId) {
      createInboxService({ state, onParkedAnswer: () => undefined }).flag({
        tier: 'ask',
        urgency: 'high',
        closesWhen: { by: 'answer' },
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

  it('installs once it has drained for DRAIN_LIMIT_MS, though steps still run', async () => {
    world.busy = 3;
    world.waitLimitMs = 0;
    const update = make();
    expect(await update.tick()).toBe('draining');
    clock.advance(DRAIN_LIMIT_MS - 1);
    expect(await update.tick()).toBe('draining');
    clock.advance(1);
    expect(await update.tick()).toBe('applying');
    expect(world.calls).toEqual(['stage', 'drain', 'pause', 'apply']);
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

    it.each(['find-commit', 'find-build'])(
      'does not say a build staged for the failed head waits for an idle moment when main moves and the look fails at %s',
      async (step) => {
        world.busy = 1;
        const update = make();
        await update.tick();
        world.busy = 0;
        world.apply = () => ({ ok: false, step: 'start-install', message: 'spawn bash ENOENT' });
        expect(await update.tick()).toBe('failed');
        // The new head clears the failure, so only the staged build's head says it is held back.
        world.head = NEWER;
        world.stage = () => Promise.resolve({ ok: false, step, message: 'gh: 502', kept: true });
        expect(await update.tick()).toBe('unreachable');
        expect(world.calls.filter((call) => call === 'apply')).toEqual(['apply']);
        const status = update.status();
        expect(status.availableCommit).toBe(NEWER);
        expect(status.problem?.kind).toBe('unreachable');
        expect(status.notInstalling).toBe('unreachable');
      },
    );

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

    it('does not say the held-back build waits for an idle moment when GitHub goes away after retry()', async () => {
      const update = await retriedAfterNewerHeadFailed();
      world.head = new Error('offline');
      expect(await update.tick()).toBe('unreachable');
      const status = update.status();
      expect(status.availableCommit).toBe('e'.repeat(40));
      expect(status.problem?.kind).toBe('unreachable');
      expect(status.notInstalling).toBe('unreachable');
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

    it.each(['find-commit', 'find-build'])(
      'does not say the held-back build waits for an idle moment when the look fails at %s after retry()',
      async (step) => {
        const update = await retriedAfterNewerHeadFailed();
        world.stage = () => Promise.resolve({ ok: false, step, message: 'gh: 502', kept: true });
        expect(await update.tick()).toBe('unreachable');
        const status = update.status();
        expect(status.availableCommit).toBe('e'.repeat(40));
        expect(status.problem?.kind).toBe('unreachable');
        expect(status.notInstalling).toBe('unreachable');
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
>>>>>>> 17760cea2f33eced17532f29f4dac6c3eb194d81
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
