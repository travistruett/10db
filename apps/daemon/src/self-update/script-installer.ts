import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { CommitSha } from '@10db/contracts';
import { z } from 'zod';
import { systemClock, type Clock, type Timer } from '../clock';
import type { Logger } from '../log';
import type {
  ApplyResult,
  ScriptStatus,
  SelfUpdateDeps,
  StagedBuild,
  StageResult,
  UpdateTarget,
} from './self-update';

/** The branch whose build the app follows. */
const BRANCH = 'main';
/** The install script's own deadline for a build is 90 minutes; this leaves it room to say so. */
export const DEFAULT_STAGE_TIMEOUT_MS = 100 * 60_000;
const STDERR_KEPT = 2_000;
/**
 * How long `stop` waits for a killed stage's pipe to close. A process that left the group can hold
 * it open; the folders are removed either way.
 */
const STOP_WAIT_MS = 5_000;
/**
 * The only places the install script finds sqlite3, shasum, hdiutil, ditto, pkill, open and the rest
 * of its tools. Never the login PATH, which can lead with a directory a lane can write.
 */
const INSTALL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/**
 * Variables of the login environment the script does not inherit: the ones a shell or the dynamic
 * loader obeys before the script's first line, and the ones that move the places it installs to.
 */
const NOT_INHERITED =
  /^(BASH_ENV|ENV|CDPATH|SHELLOPTS|BASHOPTS|PS4|IFS|GLOBIGNORE|PATH|GH_REPO|DYLD_.*|LD_.*|BASH_FUNC_.*|TENDB_INSTALL_.*)$/;

const Status = z.object({
  ok: z.boolean(),
  step: z.string(),
  message: z.string(),
  commit: z.string(),
});

export interface ScriptInstallerOptions {
  /** A folder holding `scripts/release/install-app.sh`: the bundle's `release` folder. */
  readonly releaseDir: string;
  /** Where builds are staged and statuses written: a folder of its own in the data directory. */
  readonly workDir: string;
  /** The data directory whose database the install backs up. */
  readonly dataDir: string;
  /** The gh the daemon resolved from the fixed install prefixes; the script runs this one. */
  readonly gh: string;
  /**
   * The builder's login environment, for gh's sign-in (`GH_TOKEN`, proxies, `HOME`). Its `PATH`
   * and the variables in `NOT_INHERITED` never reach the script.
   */
  readonly env: () => Readonly<Record<string, string>>;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly stageTimeoutMs?: number;
}

export interface ScriptInstaller {
  stage(target: UpdateTarget, running: string): Promise<StageResult>;
  apply(staged: StagedBuild): Promise<ApplyResult>;
  /**
   * For shutdown: kills a stage under way, with the gh it started, removes its folders, and starts no
   * stage after. An install under way is left running: it is what quits the app.
   */
  stop(): Promise<void>;
  /**
   * The builder turned the switch off: kills a stage under way, with the gh it started, and removes
   * its folders. Later stages still run.
   */
  cancel(): Promise<void>;
  readonly outcome: SelfUpdateDeps['outcome'];
  /** The marker scripts/release/rollback-app.sh leaves: the commit of the app it replaced. */
  readonly rollback: SelfUpdateDeps['rollback'];
}

/** Written by scripts/release/rollback-app.sh into the work folder, `<data dir>/self-update`. */
export const ROLLBACK_MARKER = 'rolled-back-from';

/** A stage under way: how to kill its process group, and its result once it is tidied up. */
interface StageRun {
  readonly kill: () => void;
  readonly ended: Promise<StageResult>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function readStatus(path: string): ScriptStatus | null {
  try {
    const parsed = Status.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Runs `scripts/release/install-app.sh` in its two halves. The first fetches and checks main's build
 * while the app goes on running. The second is started detached, from the staged copy of the script,
 * because it quits this app and replaces it, then starts the new one. Neither throws: whatever stops
 * one from starting is a failed step.
 */
export function createScriptInstaller(options: ScriptInstallerOptions): ScriptInstaller {
  const stageDir = join(options.workDir, 'stage');
  const stageStatus = join(options.workDir, 'stage-status.json');
  const applyStatus = join(options.workDir, 'status.json');
  const scriptIn = (root: string): string => join(root, 'scripts', 'release', 'install-app.sh');

  const clock = options.clock ?? systemClock;
  /** Where the staging script makes its temp folders, so they can be removed whatever became of it. */
  const scratchDir = join(options.workDir, 'tmp');

  const environment = (extra: Record<string, string>): Record<string, string> => {
    const inherited: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env())) {
      if (!NOT_INHERITED.test(name)) inherited[name] = value;
    }
    return {
      ...inherited,
      PATH: INSTALL_PATH,
      TENDB_INSTALL_GH: options.gh,
      TENDB_INSTALL_DATA_DIR: options.dataDir,
      ...extra,
    };
  };

  /** Set by `stop`: the daemon is quitting, and no stage starts again. */
  let stopped = false;
  let current: StageRun | null = null;

  /** Removes what a stage leaves but its status: its scratch folder, and the build unless it is kept. */
  const removeStageFiles = (keepBuild: boolean): void => {
    rmSync(scratchDir, { recursive: true, force: true });
    if (!keepBuild) rmSync(stageDir, { recursive: true, force: true });
  };
  /** The same, where a throw would have nowhere to go but the event loop. */
  const tidy = (keepBuild: boolean): void => {
    try {
      removeStageFiles(keepBuild);
    } catch (error) {
      options.logger.warn({ err: error }, 'could not remove the install script’s folders');
    }
  };

  function runStage(target: UpdateTarget, running: string): StageRun {
    const timeout = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
    let killGroup = (): void => undefined;
    /** Set when the stage is killed on purpose, by `stop` or `cancel`, not by its deadline. */
    let cancelled = false;
    const ended = new Promise<StageResult>((resolve) => {
      let child: ChildProcessByStdio<null, null, Readable>;
      try {
        child = spawn(
          '/bin/bash',
          [
            scriptIn(options.releaseDir),
            '--stage',
            stageDir,
            '--status-file',
            stageStatus,
            '--running',
            running,
            BRANCH,
          ],
          {
            cwd: options.workDir,
            env: environment({ GH_REPO: target.repo, TMPDIR: scratchDir }),
            stdio: ['ignore', 'ignore', 'pipe'],
            // Its own process group, so one kill reaches bash and the gh it started.
            detached: true,
          },
        );
      } catch (error) {
        tidy(false);
        resolve({
          ok: false,
          step: 'stage',
          message: `Could not run the install script: ${messageOf(error)}`,
        });
        return;
      }
      let stderr = '';
      let timedOut = false;
      killGroup = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The group is already gone.
        }
      };
      const deadline = clock.setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeout);
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEPT);
      });
      /** Whatever ended the script, nothing of it is left running or on disk but its status. */
      const finish = (result: StageResult): void => {
        deadline.cancel();
        killGroup();
        // Only a staged build keeps its folder; "current" fetched nothing.
        tidy(result.ok && !result.current);
        resolve(result);
      };
      child.once('error', (error) => {
        finish({
          ok: false,
          step: 'stage',
          message: `Could not run the install script: ${error.message}`,
        });
      });
      child.once('close', (code) => {
        if (stopped || cancelled) {
          finish({
            ok: false,
            step: 'stage',
            message: stopped
              ? 'The install script was stopped: 10db quit.'
              : 'The install script was stopped: Update by itself was turned off.',
          });
          return;
        }
        const status = timedOut ? null : readStatus(stageStatus);
        if (status?.ok) {
          finish(
            status.step === 'current'
              ? { ok: true, current: true, commit: status.commit }
              : { ok: true, current: false, dir: stageDir, commit: status.commit },
          );
          return;
        }
        if (status) {
          finish({ ok: false, step: status.step, message: status.message });
          return;
        }
        const how = timedOut
          ? `did not finish: it was stopped after ${String(Math.round(timeout / 60_000))} minutes`
          : `exited with code ${String(code)}`;
        options.logger.error({ code, timedOut }, 'the install script left no status');
        finish({
          ok: false,
          step: 'stage',
          message: `The install script ${how}.${stderr.trim() ? `\n\n${stderr.trim()}` : ''}`,
        });
      });
    });
    return {
      kill: () => {
        cancelled = true;
        killGroup();
      },
      ended,
    };
  }

  /** Kills the stage under way, if any, and settles once it ended or a bounded wait has passed. */
  async function killCurrent(): Promise<void> {
    const run = current;
    if (run === null) return;
    run.kill();
    let bound: Timer | null = null;
    await Promise.race([
      run.ended,
      new Promise<void>((resolve) => {
        bound = clock.setTimeout(resolve, STOP_WAIT_MS);
      }),
    ]);
    (bound as Timer | null)?.cancel();
    // A stage whose pipe never closed has had its group killed; its folders go all the same.
    tidy(false);
  }

  const rollbackMarker = join(options.workDir, ROLLBACK_MARKER);

  return {
    stage(target, running) {
      if (stopped) {
        return Promise.resolve({
          ok: false,
          step: 'stage',
          message: '10db is quitting, so the build was not fetched.',
        });
      }
      try {
        rmSync(stageStatus, { force: true });
        removeStageFiles(false);
        mkdirSync(scratchDir, { recursive: true });
      } catch (error) {
        return Promise.resolve({
          ok: false,
          step: 'stage',
          message: `Could not make a place for the build in ${options.workDir}: ${messageOf(error)}`,
        });
      }
      const run = runStage(target, running);
      current = run;
      void run.ended.then(() => {
        if (current === run) current = null;
      });
      return run.ended;
    },

    async stop() {
      stopped = true;
      await killCurrent();
    },

    cancel: killCurrent,

    apply(staged) {
      const script = scriptIn(staged.dir);
      if (!existsSync(script)) {
        return Promise.resolve({
          ok: false,
          step: 'start-install',
          message: `The staged install script ${script} is missing.`,
        });
      }
      let log: number;
      try {
        rmSync(applyStatus, { force: true });
        mkdirSync(options.workDir, { recursive: true });
        log = openSync(join(options.workDir, 'apply.log'), 'a');
      } catch (error) {
        return Promise.resolve({
          ok: false,
          step: 'start-install',
          message: `Could not make a place for the install's log in ${options.workDir}: ${messageOf(error)}`,
        });
      }
      let logOpen = true;
      const closeLog = (): void => {
        if (!logOpen) return;
        logOpen = false;
        closeSync(log);
      };
      return new Promise<ApplyResult>((resolve) => {
        const cannotStart = (error: unknown): void => {
          closeLog();
          resolve({
            ok: false,
            step: 'start-install',
            message: `Could not start ${script}: ${messageOf(error)}`,
          });
        };
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(
            '/bin/bash',
            [
              script,
              '--apply',
              staged.dir,
              '--quit-first',
              '--relaunch',
              '--status-file',
              applyStatus,
            ],
            {
              cwd: options.workDir,
              env: environment({}),
              // Its own process group and no pipe to this daemon: it outlives the app it quits.
              detached: true,
              stdio: ['ignore', log, log],
            },
          );
        } catch (error) {
          cannotStart(error);
          return;
        }
        child.once('error', cannotStart);
        child.once('spawn', () => {
          // Unreferenced, so a daemon that is quitting does not wait for it; its exit is still heard
          // while the daemon runs.
          const ended = new Promise<void>((done) => {
            child.once('exit', () => {
              done();
            });
          });
          child.unref();
          closeLog();
          resolve({ ok: true, ended });
        });
      });
    },

    rollback: {
      read() {
        try {
          const parsed = CommitSha.safeParse(readFileSync(rollbackMarker, 'utf8').trim());
          return parsed.success ? parsed.data : null;
        } catch {
          return null;
        }
      },
      clear() {
        rmSync(rollbackMarker, { force: true });
      },
    },

    outcome: {
      read: () => readStatus(applyStatus),
      clear() {
        rmSync(applyStatus, { force: true });
        rmSync(stageStatus, { force: true });
        rmSync(stageDir, { recursive: true, force: true });
      },
    },
  };
}
