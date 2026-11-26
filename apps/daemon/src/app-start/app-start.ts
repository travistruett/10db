import { join } from 'node:path';
import type { PermissionRuleDto, ProjectDto, ProjectId } from '@10db/contracts';
import { getProject } from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import { clearAppStartCard, raiseAppStartCard, type InboxService } from '../inbox';
import type { Logger } from '../log';
import { appAnswers } from '../preview';
import type { GateResult, GateRunner } from '../verify';
import { dockerAnswers, openDockerDesktop } from './docker-desktop';

// A project's own start command brings its dev stack up when a picture or the dev login finds nothing
// answering at the app address: once, under the gate's sandbox with Docker allowed, with Docker Desktop
// opened first when no engine socket answers. A start that fails or times out leaves one Inbox card and
// is not run again for a while, so a broken stack never loops.

/** The output lines a failed start's card keeps. */
const TAIL_LINES = 20;

export interface AppStartTiming {
  /** The longest the start command may run; it is expected to return once the stack is started. */
  readonly commandWithinMs: number;
  /** How long the app address has to answer once the command has returned. */
  readonly appAnswerWithinMs: number;
  /** How long Docker's socket has to answer once Docker Desktop is opened. */
  readonly dockerWithinMs: number;
  /** How often an address or socket is looked at while waiting. */
  readonly probeEveryMs: number;
  /** How long a failed start rests before a later ask runs the command again. */
  readonly retryAfterMs: number;
}

const DEFAULT_TIMING: AppStartTiming = {
  commandWithinMs: 10 * 60_000,
  appAnswerWithinMs: 3 * 60_000,
  dockerWithinMs: 2 * 60_000,
  probeEveryMs: 1_000,
  retryAfterMs: 10 * 60_000,
};

/** What a caller learns: the app answers and it can go on, or why the picture or sign-in is skipped. */
export type AppUp = { readonly up: true } | { readonly up: false; readonly why: string };

export interface AppStartDeps {
  readonly state: StateStore;
  readonly inbox: InboxService;
  /** The unslotted gate runner, as the dev login's: the command runs under the gate's sandbox. */
  readonly gate: GateRunner;
  readonly dataDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sessionEnv: () => Readonly<Record<string, string>>;
  readonly rules: (
    project: ProjectDto,
  ) => readonly Pick<PermissionRuleDto, 'toolName' | 'pattern'>[];
  readonly checkouts: () => readonly string[];
  /** The engine sockets whose answer means Docker is running. */
  readonly dockerSockets: () => readonly string[];
  /** Whether the project's stack runs in Docker, so Docker Desktop is opened when it is stopped. */
  readonly usesDocker: (project: ProjectDto) => Promise<boolean>;
  /** Whether anything answers at an address; a real look by default. */
  readonly answers?: (appUrl: string) => Promise<boolean>;
  /** Whether an engine socket answers; a real connect by default. */
  readonly dockerUp?: (sockets: readonly string[]) => Promise<boolean>;
  /** Opens Docker Desktop; `open -a Docker` by default. */
  readonly openDocker?: () => Promise<void>;
  readonly timing?: Partial<AppStartTiming>;
}

export interface AppStart {
  /**
   * Makes sure the project's app answers at its address before a picture or a sign-in. It answers up
   * at once when the project has no address or no start command, or the address answers; otherwise it
   * runs the start command once (one run at a time per project, shared by every ask) and waits for the
   * address to answer. A failed start is not run again until its wait has passed or the command or
   * address changes; each ask in the meantime gets the earlier failure's words.
   */
  ensureUp(projectId: ProjectId, signal?: AbortSignal): Promise<AppUp>;
  /** Stops a start in flight and follows nothing more. */
  stop(): Promise<void>;
}

const tailOf = (output: string): string => output.trim().split('\n').slice(-TAIL_LINES).join('\n');
const seconds = (ms: number): string => `${String(Math.round(ms / 1000))} seconds`;
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createAppStart(deps: AppStartDeps): AppStart {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const answers = deps.answers ?? appAnswers;
  const dockerUp = deps.dockerUp ?? dockerAnswers;
  const openDocker = deps.openDocker ?? openDockerDesktop;
  const log = deps.logger;
  const inflight = new Map<ProjectId, Promise<AppUp>>();
  const aborts = new Set<AbortController>();
  /** Each project's last failed start, by the command and address it was for. */
  const failures = new Map<ProjectId, { key: string; at: number; why: string }>();
  const life = { stopping: false };
  /** Read through a call, so a check after an await sees what stop() set meanwhile. */
  const stopped = (): boolean => life.stopping;
  const stoppingAnswer: AppUp = { up: false, why: 'the daemon is stopping' };

  /** Looks until `check` holds or the deadline passes; false on a deadline or a stop. */
  async function waitUntil(check: () => Promise<boolean>, withinMs: number): Promise<boolean> {
    const deadline = deps.clock.now().getTime() + withinMs;
    while (!stopped()) {
      if (await check()) return true;
      if (deps.clock.now().getTime() >= deadline) return false;
      await new Promise<void>((resolve) => {
        // A real timer on purpose: it paces real probes of a real socket and address.
        setTimeout(resolve, timing.probeEveryMs);
      });
    }
    return false;
  }

  async function wantsDocker(project: ProjectDto): Promise<boolean> {
    if (project.sandboxDocker) return true;
    try {
      return await deps.usesDocker(project);
    } catch {
      return false;
    }
  }

  /** Brings the stack up once: Docker Desktop when it is needed and stopped, then the command. */
  async function bringUp(project: ProjectDto, command: string, appUrl: string): Promise<AppUp> {
    const key = `${command}\n${appUrl}`;
    const earlier = failures.get(project.id);
    if (earlier?.key === key && deps.clock.now().getTime() - earlier.at < timing.retryAfterMs)
      return { up: false, why: earlier.why };

    const fail = (ran: string | null, saw: string): AppUp => {
      failures.set(project.id, { key, at: deps.clock.now().getTime(), why: saw });
      log.warn({ projectId: project.id, ran: ran !== null, saw }, 'the app could not be started');
      try {
        raiseAppStartCard(deps, {
          projectId: project.id,
          projectName: project.name,
          appUrl,
          ran,
          saw,
        });
      } catch (error) {
        log.warn({ projectId: project.id, err: errorText(error) }, 'the app start card not raised');
      }
      return { up: false, why: saw };
    };

    if (await wantsDocker(project)) {
      const sockets = deps.dockerSockets();
      if (!(await dockerUp(sockets))) {
        log.info({ projectId: project.id }, 'opening Docker Desktop for the app start');
        try {
          await openDocker();
        } catch (error) {
          return fail(
            null,
            `no Docker engine answered, and opening Docker Desktop failed: ${errorText(error)}`,
          );
        }
        if (!(await waitUntil(() => dockerUp(sockets), timing.dockerWithinMs))) {
          if (stopped()) return stoppingAnswer;
          return fail(
            null,
            `Docker Desktop was opened, but no Docker engine answered within ${seconds(timing.dockerWithinMs)}`,
          );
        }
      }
    }
    if (stopped()) return stoppingAnswer;

    const abort = new AbortController();
    aborts.add(abort);
    let result: GateResult;
    try {
      result = await deps.gate.run({
        // No project id: the run never turns the project's Docker switch on or leaves its note; the
        // command is the builder's own, and a stack that runs in Docker is its whole purpose.
        project: {
          repoPath: project.repoPath,
          sandboxLoopback: project.sandboxLoopback,
          sandboxDocker: true,
        },
        command,
        logPath: join(deps.dataDir, 'app-start', `${project.id}.log`),
        timeoutMs: timing.commandWithinMs,
        env: deps.sessionEnv(),
        rules: deps.rules(project),
        checkouts: deps.checkouts(),
        signal: abort.signal,
      });
    } catch (error) {
      return fail(command, `the command could not run: ${errorText(error)}`);
    } finally {
      aborts.delete(abort);
    }
    if (stopped() || result.aborted) return stoppingAnswer;
    const tail = tailOf(result.tail);
    const output = tail === '' ? '' : `\n${tail}`;
    if (result.timedOut)
      return fail(
        command,
        `the command was still running after ${seconds(timing.commandWithinMs)} and was stopped${output}`,
      );
    if (result.exitCode !== 0)
      return fail(command, `the command exited ${String(result.exitCode)}${output}`);
    if (!(await waitUntil(() => answers(appUrl), timing.appAnswerWithinMs))) {
      if (stopped()) return stoppingAnswer;
      return fail(
        command,
        `the command exited 0, but nothing answered at ${appUrl} within ${seconds(timing.appAnswerWithinMs)}${output}`,
      );
    }
    failures.delete(project.id);
    clearAppStartCard(deps, project.id);
    log.info({ projectId: project.id }, 'the app was started and answers');
    return { up: true };
  }

  /** The shared run's answer, or a stopped one the moment the caller's signal aborts. */
  function untilAborted(run: Promise<AppUp>, signal: AbortSignal | undefined): Promise<AppUp> {
    if (signal === undefined) return run;
    return new Promise<AppUp>((resolve, reject) => {
      const stoppedAnswer: AppUp = { up: false, why: 'the picture was stopped' };
      if (signal.aborted) {
        resolve(stoppedAnswer);
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          resolve(stoppedAnswer);
        },
        { once: true },
      );
      run.then(resolve, reject);
    });
  }

  return {
    async ensureUp(projectId, signal) {
      if (life.stopping) return stoppingAnswer;
      let project: ProjectDto;
      try {
        project = getProject(deps.state.db, projectId);
      } catch {
        return { up: false, why: 'the project is gone' };
      }
      const { appUrl, appStartCommand } = project;
      if (appUrl === null || appStartCommand === null) return { up: true };
      if (await answers(appUrl)) {
        failures.delete(projectId);
        clearAppStartCard(deps, projectId);
        return { up: true };
      }
      let run = inflight.get(projectId);
      if (run === undefined) {
        const started = bringUp(project, appStartCommand, appUrl).finally(() => {
          inflight.delete(projectId);
        });
        inflight.set(projectId, started);
        run = started;
      }
      return untilAborted(run, signal);
    },
    async stop() {
      life.stopping = true;
      for (const abort of aborts) abort.abort();
      await Promise.allSettled([...inflight.values()]);
    },
  };
}
