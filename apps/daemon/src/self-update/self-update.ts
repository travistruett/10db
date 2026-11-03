import type { ProjectId } from '@10db/contracts';
import { deleteAppSetting, getAppSetting, setAppSetting } from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';

/** The commit an install that is under way was fetched for, and the head of main it was chosen for. */
export const SELF_UPDATE_APPLYING_KEY = 'self_update.applying';
/** The head of main whose update failed: 10db does not try it again until main moves on or the builder asks. */
export const SELF_UPDATE_FAILED_KEY = 'self_update.failed_commit';

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
  /** The newest finished build of main is the one the app already runs: nothing was fetched. */
  | { readonly ok: true; readonly current: true; readonly commit: string }
  | { readonly ok: false; readonly step: string; readonly message: string };

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
   * is the build of `running`.
   */
  stage(target: UpdateTarget, running: string): Promise<StageResult>;
  /**
   * Kills a stage under way, with everything it started, and removes its files; settles once it is
   * gone. Leaves an install under way alone.
   */
  stopStage(): Promise<void>;
  /** Starts the install, which quits the app, swaps it and starts it again. */
  apply(staged: StagedBuild): Promise<ApplyResult>;
  /**
   * What a restart would cut off, as a count: lanes, gates and batches in the database, and the
   * delivery jobs queued or running (a ship, a checkout return, a cleanup), which are not in it yet.
   * Work that only waits is not counted.
   */
  midSession(): number;
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
  Working: 'working',
  Failed: 'failed',
  Busy: 'busy',
  Applying: 'applying',
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
  /** Lets the next check try a head of main whose update failed. */
  retry(): void;
  status(): { readonly availableCommit: string | null };
}

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
      'It will not try again by itself until main has a newer commit. To try now, turn Update by itself off and on in Settings, or run make install-app.',
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
  let applying = false;
  let timer: Timer | null = null;
  let running = false;
  /** Set by `stop`: a check still under way touches neither the database nor the log afterwards. */
  let stopped = false;
  // A function, so the checks after an await are not narrowed to the value `stopped` had before it.
  const isStopped = (): boolean => stopped;
  /** The head of main last logged as not ahead of the running build. */
  let notAheadOf: string | null = null;

  const failedHead = (): string | null => {
    const stored = getAppSetting(state.db, SELF_UPDATE_FAILED_KEY);
    return typeof stored === 'string' ? stored : null;
  };

  function fail(runningCommit: string, attempt: Attempt, step: string, message: string): void {
    state.write((ctx) => {
      setAppSetting(ctx, SELF_UPDATE_FAILED_KEY, attempt.head);
    });
    logger.error({ ...attempt, step, message }, 'could not update the app');
    const projectId = deps.cardProject();
    // A card needs a project to sit under; with none registered the log is all there is to say.
    if (projectId === null) return;
    const card = failureCard({ commit: attempt.commit, running: runningCommit, step, message });
    inbox.flag({ projectId, workstreamId: null, ...card });
  }

  async function check(runningCommit: string): Promise<TickResult> {
    if (!deps.enabled()) return TickResult.Off;
    const target: UpdateTarget = { repo: deps.repository };
    let head: string;
    try {
      head = await deps.headOf(target.repo);
    } catch (error) {
      if (isStopped()) return TickResult.Working;
      logger.warn({ err: error }, 'could not ask GitHub for the head of main');
      return TickResult.Unreachable;
    }
    if (isStopped()) return TickResult.Working;
    if (head === runningCommit) {
      available = null;
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
      return TickResult.Unreachable;
    }
    if (isStopped()) return TickResult.Working;
    if (!ahead) {
      available = null;
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
    if (failedHead() === head) return TickResult.FailedBefore;

    if (staged?.head !== head) {
      staged = null;
      const result = await deps.stage(target, runningCommit);
      // The daemon stopped while the build was fetched: its database and log are closed.
      if (isStopped()) return TickResult.Working;
      if (!result.ok) {
        fail(runningCommit, { head, commit: head }, result.step, result.message);
        return TickResult.Failed;
      }
      // The newest finished build is not the head's when the head's is still building. It is the
      // build the app runs until a newer one finishes, and then there is nothing to install.
      if (result.current) return TickResult.NoNewerBuild;
      // Never an older build: the one that was fetched must be ahead of the running commit too.
      let newer: boolean;
      try {
        newer = await deps.isAhead(target.repo, runningCommit, result.commit);
      } catch (error) {
        if (isStopped()) return TickResult.Working;
        logger.warn({ err: error }, 'could not ask GitHub how the staged build compares');
        return TickResult.Unreachable;
      }
      if (isStopped()) return TickResult.Working;
      if (!newer) {
        logger.info(
          { running: runningCommit, build: result.commit },
          'the newest finished build is not ahead of the running one, so it is not installed',
        );
        return TickResult.NoNewerBuild;
      }
      staged = { dir: result.dir, commit: result.commit, head };
    }

    if (deps.midSession() > 0) return TickResult.Busy;
    return install(runningCommit, { head, commit: staged.commit }, staged);
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
      result = await deps.apply(build);
    } catch (error) {
      if (isStopped()) return TickResult.Working;
      return notStarted(runningCommit, attempt, 'start-install', messageOf(error));
    }
    if (isStopped()) return TickResult.Working;
    if (!result.ok) return notStarted(runningCommit, attempt, result.step, result.message);
    applying = true;
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

  async function tick(): Promise<TickResult> {
    if (deps.runningCommit === null) return TickResult.Disabled;
    if (working || applying) return TickResult.Working;
    working = true;
    try {
      return await check(deps.runningCommit);
    } finally {
      working = false;
    }
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
      state.write((ctx) => {
        deleteAppSetting(ctx, SELF_UPDATE_FAILED_KEY);
      });
    },
    status: () => ({ availableCommit: available }),
  };
}
