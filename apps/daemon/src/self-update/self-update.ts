import type { ProjectId, SelfUpdateBlockerDto, SelfUpdateNotInstalling } from '@10db/contracts';
import { deleteAppSetting, getAppSetting, setAppSetting } from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { SELF_UPDATE_SWITCH } from './blocker';

/** The commit an install that is under way was fetched for, and the head of main it was chosen for. */
export const SELF_UPDATE_APPLYING_KEY = 'self_update.applying';
/** The head of main whose update failed: 10db does not try it again until main moves on or the builder asks. */
export const SELF_UPDATE_FAILED_KEY = 'self_update.failed_commit';
/**
 * The commit `make rollback-app` replaced: 10db does not install that build again by itself, nor
 * update while main's head is still that commit, until the builder touches the switch.
 */
export const SELF_UPDATE_ROLLED_BACK_KEY = 'self_update.rolled_back_from';

/** The GitHub repository (`owner/name`) the builds come from: the one the app was built for. */
export interface UpdateTarget {
  readonly repo: string;
}

/** A build fetched and checked, ready to install. */
export interface StagedBuild {
  readonly dir: string;
  /** The commit the build was made from: the newest finished build of main, not always its head. */
  readonly commit: string;
}

export type StageResult =
  | ({ readonly ok: true; readonly current: false } & StagedBuild)
  /**
   * The newest finished build of main is the one the app already runs, or the one it was told to
   * skip: nothing was fetched.
   */
  | { readonly ok: true; readonly current: true; readonly commit: string }
  | {
      readonly ok: false;
      readonly step: string;
      readonly message: string;
      /** The build the stage was told to keep is still whole in its folder. */
      readonly kept?: true;
    };

export type ApplyResult =
  | {
      readonly ok: true;
      /**
       * Settles when the detached install script exits. A script that quits the app ends this
       * daemon first, so a daemon that sees it settle is still running: the install failed before
       * the quit (the lock was held, or the app would not quit) and left the app as it was.
       */
      readonly ended: Promise<void>;
    }
  | { readonly ok: false; readonly step: string; readonly message: string };

/** What the install script wrote when it ended (scripts/release/install-app.sh --status-file). */
export interface ScriptStatus {
  readonly ok: boolean;
  readonly step: string;
  readonly message: string;
  readonly commit: string;
}

export interface SelfUpdateDeps {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The commit this app was built from; null for a source run, which never updates itself. */
  readonly runningCommit: string | null;
  /** How often main is looked at. */
  readonly intervalMs: number;
  /**
   * The repository the app follows, fixed when it was built (build-info.json). Nothing a project,
   * a checkout or a setting says changes it.
   */
  readonly repository: string;
  /** Whether the builder's switch is on. */
  enabled(): boolean;
  /** The project a card is raised under, which only places it in the Inbox; null when there is none. */
  cardProject(): ProjectId | null;
  /** The commit at the head of main on GitHub. Rejects when GitHub can't be reached. */
  headOf(repo: string): Promise<string>;
  /**
   * Whether `head` is ahead of `base`: main holds all of it and more. False for a build from another
   * branch, which is not replaced by an older main, and for a build older than the running one.
   * Rejects when GitHub can't be asked.
   */
  isAhead(repo: string, base: string, head: string): Promise<boolean>;
  /**
   * Fetches and checks the newest finished build of main while the app goes on running, unless that
   * is the build of `running` or of `skip` (the commit the builder rolled back from). When it is
   * the build of `keep` (the one already staged), nothing is fetched and the staged folder stays as
   * it is; the result then names that same dir and commit. A stage that fails leaves that folder
   * too, unless it had begun replacing it, and says so with `kept`.
   */
  stage(
    target: UpdateTarget,
    running: string,
    skip: string | null,
    keep: string | null,
  ): Promise<StageResult>;
  /**
   * Kills a stage under way, with everything it started, and removes its files; settles once it is
   * gone. Leaves an install under way alone.
   */
  stopStage(): Promise<void>;
  /**
   * Kills a stage under way because the builder turned the switch off, and removes its files;
   * settles once it is gone. Unlike `stopStage`, later stages still run.
   */
  cancelStage(): Promise<void>;
  /**
   * The marker `make rollback-app` leaves in the data directory: the commit of the app it
   * replaced. Read and cleared at startup.
   */
  readonly rollback: { read(): string | null; clear(): void };
  /** Starts the install, which quits the app, swaps it and starts it again. */
  apply(staged: StagedBuild): Promise<ApplyResult>;
  /**
   * What a restart would cut off, as a count: lanes, gates and batches in the database, and the
   * delivery jobs queued or running (a ship, a checkout return, a cleanup), which are not in it yet.
   * Work that only waits is not counted.
   */
  midSession(): number;
  /** How long a staged build waits for an idle moment before the factory drains for it. */
  waitLimitMs(): number;
  /**
   * The factory's drain: from `begin`, nothing new starts (no lane, no session, no gate, no ship)
   * and nothing that runs is stopped; `end` lets work start again. Both are idempotent here.
   */
  readonly drain: { begin(since: Date): void; end(): void };
  /**
   * Stops the scheduler starting new work and settles once the tick it was in has finished, so
   * nothing begins between the last check and the quit.
   */
  pause(): Promise<void>;
  resume(): void;
  /** The install script's last status file, and its removal. */
  readonly outcome: { read(): ScriptStatus | null; clear(): void };
}

export const TickResult = {
  Disabled: 'disabled',
  Off: 'off',
  Unreachable: 'unreachable',
  Current: 'current',
  NotAhead: 'not-ahead',
  NoNewerBuild: 'no-newer-build',
  FailedBefore: 'failed-before',
  RolledBack: 'rolled-back',
  Working: 'working',
  Failed: 'failed',
  Busy: 'busy',
  Applying: 'applying',
  /** The update has waited past the limit (or the builder asked): new work is held until it installs. */
  Draining: 'draining',
} as const;
export type TickResult = (typeof TickResult)[keyof typeof TickResult];

export interface SelfUpdate {
  /** One look at main: stage a newer build, and install it when no task is mid-session. */
  tick(): Promise<TickResult>;
  /** At startup: reports how an install that was under way ended. */
  settle(): void;
  /** Looks again every interval until `stop`. */
  start(): void;
  /**
   * For shutdown: from the call on, a check under way touches neither the scheduler, the database
   * nor the log, and no check starts; settles once a stage under way has been killed.
   */
  stop(): Promise<void>;
  /**
   * Lets the next check try a head of main whose update failed, or the build `make rollback-app`
   * replaced.
   */
  retry(): void;
  /**
   * The builder turned the switch off: kills a stage under way and forgets a staged build. A check
   * under way looks at the switch again before it installs, so nothing installs from here on.
   */
  turnOff(): Promise<void>;
  /**
   * The builder wants the update now: starts the drain at once when a build is staged and work is
   * running, and otherwise the moment one is staged. Does nothing when no update is available.
   */
  installNow(): void;
  status(): SelfUpdateProgress;
}

/** What the builder sees of an update: that it is waiting, and whether the factory drains for it. */
export interface SelfUpdateProgress {
  readonly availableCommit: string | null;
  /** When the build was staged and began to wait for an idle moment; null with no staged build. */
  readonly waitingSince: Date | null;
  readonly draining: boolean;
  /** When new work stopped starting; null while it is not held. */
  readonly drainingSince: Date | null;
  /**
   * Why a switched-on app is not updating right now: GitHub can't be asked, or the update to main's
   * head failed. Null while the switch is off and while nothing is wrong.
   */
  readonly problem: SelfUpdateBlockerDto | null;
  /**
   * Why the available update is not waiting to install: its update failed, the builder rolled back
   * from it, or it has no finished build newer than the running one. Null while it waits, installs
   * or none is available.
   */
  readonly notInstalling: SelfUpdateNotInstalling | null;
}

/** What a check's result says about an available update that will not install. */
const NOT_INSTALLING: Readonly<Partial<Record<TickResult, SelfUpdateNotInstalling>>> = {
  [TickResult.Failed]: 'failed',
  [TickResult.FailedBefore]: 'failed',
  [TickResult.RolledBack]: 'rolled-back',
  [TickResult.NoNewerBuild]: 'unbuilt',
};

const STEP_LABELS: Readonly<Record<string, string>> = {
  'find-commit': 'asking GitHub for the head of main',
  'find-build': 'finding the build of main',
  'wait-for-build': 'waiting for the build of main',
  download: 'downloading the build',
  'verify-checksum': 'checking the download',
  'staged-build': 'finding the downloaded build',
  stage: 'keeping the build',
  'start-install': 'starting the install',
  lock: 'taking the install lock',
  quit: 'quitting 10db',
  'backup-database': 'backing up the database',
  'zip-previous': 'keeping the previous app',
  install: 'installing the new app',
  relaunch: 'starting 10db again',
  unknown: 'installing the new build',
};

/** The steps of a stage that come before it knows which build is newest. */
const LOOKING_STEPS: ReadonlySet<string> = new Set(['find-commit', 'find-build']);

const short = (commit: string): string => commit.slice(0, 12);
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What a failure is about: the head of main it was found for, and the build chosen for it. */
interface Attempt {
  readonly head: string;
  readonly commit: string;
}

function failureCard(input: {
  readonly commit: string;
  readonly running: string;
  readonly step: string;
  readonly message: string;
}) {
  const label = STEP_LABELS[input.step] ?? input.step;
  return {
    title: `Updating 10db failed: ${label}`,
    body: [
      `10db tried to install the newest finished build of main (${short(input.commit)}) and failed while ${label}. The app is still running ${short(input.running)}; if it was replaced, make rollback-app puts the previous one back.`,
      input.message,
      `It will not try again by itself until main has a newer commit. To try now, turn ${SELF_UPDATE_SWITCH} off and on in Settings, or run make install-app.`,
    ].join('\n\n'),
    foldKey: `self-update:${input.commit}`,
    refresh: true,
  };
}

function isApplying(value: unknown): value is Attempt {
  return (
    typeof value === 'object' &&
    value !== null &&
    'commit' in value &&
    typeof value.commit === 'string' &&
    'head' in value &&
    typeof value.head === 'string'
  );
}

export function createSelfUpdate(deps: SelfUpdateDeps): SelfUpdate {
  const { state, inbox, logger } = deps;
  let available: string | null = null;
  let staged: (StagedBuild & { readonly head: string }) | null = null;
  let working = false;
  /** From the moment the install is asked to start: the app is about to quit. */
  let applying = false;
  let timer: Timer | null = null;
  let running = false;
  /** Set by `stop`: a check still under way touches neither the database nor the log afterwards. */
  let stopped = false;
  // A function, so the checks after an await are not narrowed to the value `stopped` had before it.
  const isStopped = (): boolean => stopped;
  /** The head of main last logged as not ahead of the running build. */
  let notAheadOf: string | null = null;

  /** When the staged build began to wait for an idle moment. */
  let waitingSince: Date | null = null;
  /** When the factory began to drain for it: new work starts nothing from then on. */
  let drainingSince: Date | null = null;
  /** The builder chose Install Now: the wait limit has run out, whatever the clock says. */
  let forced = false;

  function startDrain(): void {
    if (drainingSince !== null) return;
    drainingSince = deps.clock.now();
    logger.info(
      { available, waitedSince: waitingSince?.toISOString() ?? null, forced },
      'an update is waiting: holding new lanes, sessions, gates and ships until it installs',
    );
    deps.drain.begin(drainingSince);
  }

  function endDrain(): void {
    if (drainingSince === null) return;
    drainingSince = null;
    logger.info({}, 'the update no longer waits: lanes start again');
    deps.drain.end();
  }

  /**
   * Main has an update, but no build of it to install yet: work starts again and nothing waits, and
   * Install Now stays asked for, so the factory drains the moment a build is staged.
   */
  function noBuildYet(): void {
    waitingSince = null;
    endDrain();
  }

  /** The update is not going to install: work starts again, and the wait is forgotten. */
  function clearWaiting(): void {
    forced = false;
    noBuildYet();
  }

  const failedHead = (): string | null => {
    const stored = getAppSetting(state.db, SELF_UPDATE_FAILED_KEY);
    return typeof stored === 'string' ? stored : null;
  };
  const rolledBackFrom = (): string | null => {
    const stored = getAppSetting(state.db, SELF_UPDATE_ROLLED_BACK_KEY);
    return typeof stored === 'string' ? stored : null;
  };

  /** The failed update Settings tells the builder about, for the head of main it was found for. */
  let failure: { readonly head: string; readonly message: string } | null = null;
  /** The last check could not ask GitHub. */
  let unreachable = false;
  /** Why the last check found nothing to install for the available head, when it did. */
  let notInstalling: SelfUpdateNotInstalling | null = null;

  function fail(runningCommit: string, attempt: Attempt, step: string, message: string): void {
    state.write((ctx) => {
      setAppSetting(ctx, SELF_UPDATE_FAILED_KEY, attempt.head);
    });
    logger.error({ ...attempt, step, message }, 'could not update the app');
    // Whatever the Inbox does, Settings says it: with no project there is no card to carry it.
    failure = {
      head: attempt.head,
      message: `The update to ${short(attempt.commit)} failed while ${STEP_LABELS[step] ?? step}: ${message.trim().replace(/\.$/, '')}. It will not try again by itself until main has a newer commit; turn ${SELF_UPDATE_SWITCH} off and on to try now.`,
    };
    clearWaiting();
    const projectId = deps.cardProject();
    // A card needs a project to sit under; with none registered the log is all there is to say.
    if (projectId === null) return;
    const card = failureCard({ commit: attempt.commit, running: runningCommit, step, message });
    inbox.flag({ projectId, workstreamId: null, ...card });
  }

  async function check(runningCommit: string): Promise<TickResult> {
    if (!deps.enabled()) {
      clearWaiting();
      return TickResult.Off;
    }
    const target: UpdateTarget = { repo: deps.repository };
    let head: string;
    try {
      head = await deps.headOf(target.repo);
    } catch (error) {
      if (isStopped()) return TickResult.Working;
      logger.warn({ err: error }, 'could not ask GitHub for the head of main');
      return withoutGitHub(runningCommit);
    }
    if (isStopped()) return TickResult.Working;
    if (head === runningCommit) {
      available = null;
      failure = null;
      clearWaiting();
      return TickResult.Current;
    }
    // Only a main that holds the running commit and more is an update. A build installed from
    // another branch is newer than main in its own way, and is never replaced by it.
    let ahead: boolean;
    try {
      ahead = await deps.isAhead(target.repo, runningCommit, head);
    } catch (error) {
      if (isStopped()) return TickResult.Working;
      logger.warn({ err: error }, 'could not ask GitHub how main compares with this build');
      return withoutGitHub(runningCommit);
    }
    if (isStopped()) return TickResult.Working;
    if (!ahead) {
      available = null;
      failure = null;
      clearWaiting();
      // Once per head of main, so the log says why this build never updates by itself.
      if (notAheadOf !== head) {
        notAheadOf = head;
        logger.info(
          { running: runningCommit, main: head },
          'main is not ahead of the running build, so it is left as it is',
        );
      }
      return TickResult.NotAhead;
    }
    available = head;
    // A failure is about one head of main: a newer head is a fresh start.
    if (failure !== null && failure.head !== head) failure = null;
    if (failedHead() === head) {
      // After a restart the reason is gone with the process; the failed head is not.
      failure ??= {
        head,
        message: `An earlier update to ${short(head)} failed. It will not try again by itself until main has a newer commit; turn ${SELF_UPDATE_SWITCH} off and on to try now.`,
      };
      clearWaiting();
      return TickResult.FailedBefore;
    }
    // The builder rolled back from this head: it stays rolled back until main moves on.
    if (rolledBackFrom() === head) {
      clearWaiting();
      return TickResult.RolledBack;
    }

    // The staged build is the newest finished one as of when it was fetched, not tied to the head
    // it was found for. Main's head moving asks again which build is newest, and the stage fetches
    // nothing when it is the staged one. A staged build that is not the head's own may also have a
    // newer one since: once nothing is mid-session it is about to install, so it is asked again
    // first: never an older build than main's newest, and one quit instead of two.
    const olderThanHead = staged !== null && staged.commit !== head;
    if (staged?.head !== head || (olderThanHead && deps.midSession() === 0)) {
      const keep = staged?.commit ?? null;
      // The build the builder rolled back from is not fetched again, so a check while main's head
      // is still building costs a look at GitHub, not a download.
      const skip = rolledBackFrom();
      const result = await deps.stage(target, runningCommit, skip, keep);
      // The daemon stopped while the build was fetched: its database and log are closed.
      if (isStopped()) return TickResult.Working;
      // Turned off while the build was fetched: a stage it killed is no failure, and nothing installs.
      if (!deps.enabled()) {
        staged = null;
        clearWaiting();
        return TickResult.Off;
      }
      if (!result.ok) {
        if (result.kept === true && staged !== null) {
          // The look itself failed, so this is GitHub being away, however far the check got.
          if (LOOKING_STEPS.has(result.step)) {
            logger.warn(
              { step: result.step, message: result.message },
              'could not look for a newer build than the staged one',
            );
            return withoutGitHub(runningCommit);
          }
          // A newer build exists and did not arrive. The staged one stays for the next try, as the
          // failed head's: it does not install, not even with GitHub away.
          staged = { ...staged, head };
        } else {
          staged = null;
        }
        fail(runningCommit, { head, commit: head }, result.step, result.message);
        return TickResult.Failed;
      }
      // The folder now holds what the stage reports, whatever it held before.
      staged = null;
      // The newest finished build is not the head's when the head's is still building. It is the
      // build the app runs until a newer one finishes, and then there is nothing to install. Nor
      // when it is the build the builder rolled back from; the next check looks again.
      if (result.current) {
        noBuildYet();
        return skip !== null && result.commit === skip
          ? TickResult.RolledBack
          : TickResult.NoNewerBuild;
      }
      // Never an older build: the one that was fetched must be ahead of the running commit too. The
      // staged one was checked when it was fetched, and the running commit has not changed.
      let newer = keep !== null && result.commit === keep;
      try {
        newer ||= await deps.isAhead(target.repo, runningCommit, result.commit);
      } catch (error) {
        if (isStopped()) return TickResult.Working;
        logger.warn({ err: error }, 'could not ask GitHub how the staged build compares');
        // The stage replaced the build it could have fallen back on, so no drain has anything to
        // install. The next check fetches again, and the update's wait goes on from where it was.
        endDrain();
        return TickResult.Unreachable;
      }
      if (isStopped()) return TickResult.Working;
      if (!newer) {
        noBuildYet();
        logger.info(
          { running: runningCommit, build: result.commit },
          'the newest finished build is not ahead of the running one, so it is not installed',
        );
        return TickResult.NoNewerBuild;
      }
      staged = { dir: result.dir, commit: result.commit, head };
      // A newer head restages while the update waits: the wait goes on from the first staging.
      waitingSince ??= deps.clock.now();
    }
    return installWhenIdle(runningCommit, staged);
  }

  /**
   * GitHub can't be asked. A staged build was checked when it was fetched and installs with no
   * network, so it goes on waiting, draining or installing, unless its install, or the fetch of a
   * newer build, already failed. With none the drain has nothing to install and would hold lanes for
   * as long as GitHub stays away.
   */
  async function withoutGitHub(runningCommit: string): Promise<TickResult> {
    if (staged === null || staged.head === failedHead()) {
      endDrain();
      return TickResult.Unreachable;
    }
    return installWhenIdle(runningCommit, staged);
  }

  /** The staged build installs when nothing is mid-session; until then it waits or drains. */
  async function installWhenIdle(
    runningCommit: string,
    build: StagedBuild & { readonly head: string },
  ): Promise<TickResult> {
    // Main's head has no newer finished build than the one the builder rolled back from. The copy
    // is dropped, so the next check looks again for the head's build instead of keeping this one.
    if (build.commit === rolledBackFrom()) {
      staged = null;
      noBuildYet();
      return TickResult.RolledBack;
    }
    if (!deps.enabled()) {
      clearWaiting();
      return TickResult.Off;
    }
    if (deps.midSession() > 0) return waitOrDrain();
    return install(runningCommit, { head: build.head, commit: build.commit }, build);
  }

  /**
   * Work is running, so the build can't install yet. Within the limit it waits quietly; past it (or
   * once the builder asked) the factory drains: nothing new starts until what runs has finished.
   */
  function waitOrDrain(): TickResult {
    const waited = waitingSince === null ? 0 : deps.clock.now().getTime() - waitingSince.getTime();
    if (drainingSince === null && !forced && waited < deps.waitLimitMs()) return TickResult.Busy;
    startDrain();
    return TickResult.Draining;
  }

  /**
   * Holds new work back, looks again, and starts the install. From the pause on, every way out but
   * the install starting lets work go on: a throw too, which would otherwise leave the scheduler
   * stopped and the next check pausing it again.
   */
  async function install(
    runningCommit: string,
    attempt: Attempt,
    build: StagedBuild,
  ): Promise<TickResult> {
    let result: ApplyResult;
    try {
      // New work is held back from here on, and the tick the scheduler was in has finished, so a
      // lane that began since the first look is counted by the second.
      await deps.pause();
      // Shutting down: the scheduler is stopped for good and the database is about to close.
      if (isStopped()) return TickResult.Working;
      // The builder turned the switch off while new work was held back.
      if (!deps.enabled()) {
        deps.resume();
        clearWaiting();
        return TickResult.Off;
      }
      if (deps.midSession() > 0) {
        deps.resume();
        return TickResult.Busy;
      }
      state.write((ctx) => {
        setAppSetting(ctx, SELF_UPDATE_APPLYING_KEY, {
          head: attempt.head,
          commit: attempt.commit,
        });
      });
      // Before the install is asked for: a lane released from here on would be cut off by the quit.
      applying = true;
      result = await deps.apply(build);
    } catch (error) {
      if (isStopped()) return TickResult.Working;
      return notStarted(runningCommit, attempt, 'start-install', messageOf(error));
    }
    if (isStopped()) return TickResult.Working;
    if (!result.ok) return notStarted(runningCommit, attempt, result.step, result.message);
    logger.info({ ...attempt }, 'installing the newest finished build of main');
    void result.ended
      .then(() => {
        endedWhileRunning(runningCommit, attempt);
      })
      .catch((error: unknown) => {
        if (!isStopped()) logger.error({ err: error }, 'could not settle the ended install');
      });
    return TickResult.Applying;
  }

  /** The install never started: work goes on first, then the card. */
  function notStarted(
    runningCommit: string,
    attempt: Attempt,
    step: string,
    message: string,
  ): TickResult {
    applying = false;
    deps.resume();
    state.write((ctx) => {
      deleteAppSetting(ctx, SELF_UPDATE_APPLYING_KEY);
    });
    fail(runningCommit, attempt, step, message);
    return TickResult.Failed;
  }

  /** The install script exited and this daemon was not quit: work goes on, and a card says why. */
  function endedWhileRunning(runningCommit: string, attempt: Attempt): void {
    // Stopping means the app was quit for the install; the next start settles it.
    if (isStopped() || !applying) return;
    const status = deps.outcome.read();
    deps.outcome.clear();
    applying = false;
    staged = null;
    deps.resume();
    state.write((ctx) => {
      deleteAppSetting(ctx, SELF_UPDATE_APPLYING_KEY);
    });
    if (status && !status.ok) {
      fail(runningCommit, attempt, status.step, status.message);
    } else if (status) {
      fail(
        runningCommit,
        attempt,
        'quit',
        'The install script reported that it finished, but this 10db was never quit and still runs the old build.',
      );
    } else {
      fail(
        runningCommit,
        attempt,
        'unknown',
        'The install script ended while 10db was still running, and left no report of the step it stopped at.',
      );
    }
  }

  /**
   * Moves the marker `make rollback-app` left into the database, where it outlives restarts. A
   * marker naming the commit that runs means the builder rolled back to it again: nothing to hold.
   */
  function takeInRollback(): void {
    const from = deps.rollback.read();
    if (from === null) return;
    if (from !== deps.runningCommit) {
      state.write((ctx) => {
        setAppSetting(ctx, SELF_UPDATE_ROLLED_BACK_KEY, from);
      });
      logger.info(
        { rolledBackFrom: from, running: deps.runningCommit },
        'make rollback-app replaced this build: it is not installed again until main moves on',
      );
    }
    deps.rollback.clear();
  }

  async function tick(): Promise<TickResult> {
    if (deps.runningCommit === null) return TickResult.Disabled;
    if (working || applying) return TickResult.Working;
    working = true;
    try {
      const result = await check(deps.runningCommit);
      // Working means the check ended early because the daemon is stopping: it learned nothing.
      if (result !== TickResult.Working) {
        unreachable = result === TickResult.Unreachable;
        notInstalling = NOT_INSTALLING[result] ?? null;
      }
      return result;
    } finally {
      working = false;
    }
  }

  /** A failed update is the more useful thing to say: GitHub answering again does not undo it. */
  function problem(): SelfUpdateBlockerDto | null {
    if (failure !== null) return { kind: 'failed', message: failure.message };
    if (unreachable) {
      return {
        kind: 'unreachable',
        message:
          'gh could not reach GitHub, so 10db cannot see new builds. It is signed out or offline: check gh auth status, and 10db tries again every minute.',
      };
    }
    return null;
  }

  function schedule(): void {
    timer = deps.clock.setTimeout(() => {
      timer = null;
      if (!running) return;
      tick()
        .catch((error: unknown) => {
          if (!stopped) logger.error({ err: error }, 'the self-update check failed');
        })
        .finally(() => {
          if (running) schedule();
        });
    }, deps.intervalMs);
  }

  return {
    tick,
    settle() {
      takeInRollback();
      const status = deps.outcome.read();
      deps.outcome.clear();
      const marker = getAppSetting(state.db, SELF_UPDATE_APPLYING_KEY);
      if (!isApplying(marker) || deps.runningCommit === null) return;
      state.write((ctx) => {
        deleteAppSetting(ctx, SELF_UPDATE_APPLYING_KEY);
      });
      if (marker.commit === deps.runningCommit) {
        logger.info({ commit: marker.commit }, 'updated the app');
        return;
      }
      const failure = status && !status.ok ? status : null;
      fail(
        deps.runningCommit,
        marker,
        failure?.step ?? (status ? 'relaunch' : 'unknown'),
        failure?.message ??
          (status
            ? 'The install finished, but the app that started is not the build it installed.'
            : 'The install did not finish, and left no report of the step it stopped at.'),
      );
    },
    start() {
      if (running) return;
      running = true;
      stopped = false;
      schedule();
    },
    async stop() {
      running = false;
      stopped = true;
      timer?.cancel();
      timer = null;
      // A stage can be waiting on GitHub's build for many minutes, with gh and the builder's token.
      await deps.stopStage();
    },
    retry() {
      failure = null;
      state.write((ctx) => {
        deleteAppSetting(ctx, SELF_UPDATE_FAILED_KEY);
        deleteAppSetting(ctx, SELF_UPDATE_ROLLED_BACK_KEY);
      });
    },
    async turnOff() {
      staged = null;
      // Before the stage is killed: lanes start again at once, not once gh has gone. Not once the
      // install has started, which the switch can't stop: the quit would cut them off. If the
      // install fails with this daemon still running, that ends the drain.
      if (!applying) clearWaiting();
      await deps.cancelStage();
    },
    installNow() {
      if (available === null || !deps.enabled() || deps.runningCommit === null) return;
      forced = true;
      if (staged !== null && deps.midSession() > 0) startDrain();
      // A check under way takes `forced` up when it gets there; otherwise this one does.
      tick().catch((error: unknown) => {
        if (!stopped) logger.error({ err: error }, 'the self-update check failed');
      });
    },
    status: () => ({
      availableCommit: available,
      waitingSince,
      draining: drainingSince !== null,
      drainingSince,
      problem: !deps.enabled() ? null : problem(),
      notInstalling:
        available === null || !deps.enabled()
          ? null
          : // A failure outside a check (an install that ended, a start that settled it) counts too.
            failure !== null
            ? 'failed'
            : notInstalling,
    }),
  };
}
