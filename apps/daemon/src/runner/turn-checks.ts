import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  EventType,
  PassId,
  PassNoticeKind,
  PassState,
  PassTurnCheck,
  PassTurnId,
  passHeldAreas,
  TaskId,
  TaskMessageAuthor,
  WorkstreamState,
  type ProjectDto,
} from '@10db/contracts';
import {
  clearPassNotice,
  findPass,
  getProject,
  getWorkstream,
  insertSystemNotice,
  listPassCheckPids,
  listPassTasks,
  listPermissionRules,
  listTaskThread,
  markTurnsChecked,
  offerToAgent,
  openPassTurn,
  setPassCheckPid,
  setPassNotice,
  takeOffer,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { Clock } from '../clock';
import { allCheckouts } from '../delivery';
import type { EventBus, StateStore } from '../events';
import type { Git } from '../git';
import type { Logger } from '../log';
import type { GateResult, GateRunner } from '../verify';
import { CHECK_FAILED, checkNoticeLine, checkOffer, checkTargets } from './check-targets';
import { CHECK_IDLE, step, type CheckQueueState, type TurnAsk } from './turn-check-queue';

// Workbench spec §8.1, W16, D19: after a page's turn ends Ready, the project's changed-files check
// runs in the folder as advice, through the one gate runner and its slots. It is coalesced per pass
// (`turn-check-queue.ts`); a failure is offered on the threads it names and in the pass's header,
// never sent; nothing waits on it, no attempt moves and no turn starts.

/** The longest a turn check runs: advice must not hold the Mac's only gate slot for a gate's time. */
export const TURN_CHECK_TIMEOUT_MS = 10 * 60_000;

/** How much of the check's log the targets read: its end, where a failure is said. */
const LOG_TAIL_BYTES = 64 * 1024;

/** The header's one notice of the pass's turn check. */
const TURN_CHECK_NOTICE = 'turn-check';

/** The exit code of a gate whose sandbox could not start (`verify/gate-runner.ts`). */
const UNSTARTED_EXIT = 126;

export interface TurnChecks {
  /** A page's turn ended Ready: coalesced per pass, run through the one gate slot. */
  ask(input: {
    readonly passId: PassId;
    readonly taskId: TaskId;
    readonly turnId: PassTurnId;
  }): void;
  /** Aborts the pass's running check and drops its waiting one; resolves once the run has ended. */
  stop(passId: PassId): Promise<void>;
  stopAll(): Promise<void>;
}

export interface TurnChecksDeps {
  readonly state: StateStore;
  readonly git: Pick<Git, 'changedPaths'>;
  /** The shipping gates' runner: the shared slots, held back by the load guard. */
  readonly gate: GateRunner;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly dataDir: string;
  sessionEnv(project: ProjectDto): Readonly<Record<string, string>>;
  identifyProcess(pid: number): Promise<string | null>;
  /** The longest a check runs; the gate's timeout when that is shorter. */
  readonly timeoutMs: number;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** How a check that did not pass or fail could not run, in the builder's words. */
function unrunText(result: GateResult): string {
  const said = result.tail.trim().split('\n').at(-1) ?? '';
  const why = result.dockerRefused === true ? 'Docker is off for this project' : said;
  return `The changed-files check after a turn could not run${why === '' ? '' : `: ${why}`}`;
}

/** The end of the check's log, where a failure is said; the tail it reported when it can't be read. */
async function outputOf(result: GateResult): Promise<string> {
  try {
    const text = await readFile(result.logPath, 'utf8');
    return text.length <= LOG_TAIL_BYTES ? text : text.slice(-LOG_TAIL_BYTES);
  } catch {
    return result.tail;
  }
}

/** The folder's paths as an output may print them: as registered, and resolved. */
function rootsOf(repoPath: string): string[] {
  try {
    return [...new Set([repoPath, realpathSync(repoPath)])];
  } catch {
    return [repoPath];
  }
}

function createTurnChecks(deps: TurnChecksDeps): TurnChecks {
  const db = deps.state.db;
  const queues = new Map<PassId, CheckQueueState>();
  const runs = new Map<
    PassId,
    { readonly run: number; readonly abort: AbortController; done: Promise<void> }
  >();

  /** The project of an open pass with a changed-files check, or null. */
  function checkedProject(passId: PassId): ProjectDto | null {
    const pass = findPass(db, passId);
    if (pass?.state !== PassState.Open) return null;
    const project = getProject(db, pass.projectId);
    return project.changedCheckCommand === null ? null : project;
  }

  /** Writes in one write, only while the pass is open: a stopped or late run writes nothing. */
  function whileOpen(passId: PassId, write: (w: WriteContext) => void): void {
    deps.state.write((w) => {
      if (findPass(w.tx, passId)?.state !== PassState.Open) return;
      write(w);
    });
  }

  function apply(passId: PassId, event: Parameters<typeof step>[1]): void {
    const next = step(queues.get(passId) ?? CHECK_IDLE, event);
    queues.set(passId, next.state);
    for (const effect of next.effects) {
      switch (effect.kind) {
        case 'start':
          start(passId, effect.run, effect.turns);
          break;
        case 'abort':
          if (runs.get(passId)?.run === effect.run) runs.get(passId)?.abort.abort();
          break;
      }
    }
  }

  function start(passId: PassId, run: number, turns: readonly TurnAsk[]): void {
    const abort = new AbortController();
    const live = { run, abort, done: Promise.resolve() };
    runs.set(passId, live);
    live.done = check(passId, turns, abort.signal)
      .catch((error: unknown) => {
        // A run that threw (a spawn error, a write refused) says so and lets the next one start.
        deps.logger.warn({ passId, err: message(error) }, 'turn check not run');
        if (!abort.signal.aborted)
          tell(passId, `The changed-files check after a turn could not run: ${message(error)}`);
      })
      .finally(() => {
        if (runs.get(passId) === live) runs.delete(passId);
        apply(passId, { kind: 'ended', run });
      });
  }

  /** Says in the header, not offered, that the check could not run; the turns stay unchecked. */
  function tell(passId: PassId, text: string): void {
    whileOpen(passId, (w) => {
      setPassNotice(w, passId, {
        id: TURN_CHECK_NOTICE,
        kind: PassNoticeKind.TurnCheck,
        text,
        sendable: false,
        cardId: null,
        at: w.now,
      });
    });
  }

  async function check(passId: PassId, turns: readonly TurnAsk[], signal: AbortSignal) {
    const project = checkedProject(passId);
    const command = project?.changedCheckCommand ?? null;
    // A function, so the checks after the awaits are not narrowed away by the one before them.
    const stopped = (): boolean => signal.aborted;
    if (project === null || command === null || stopped()) return;
    const logPath = join(
      deps.dataDir,
      'logs',
      'gate',
      `pass-${passId}-check-${String(deps.clock.now().getTime())}.log`,
    );
    let recording: Promise<void> = Promise.resolve();
    let result: GateResult;
    try {
      result = await deps.gate.run({
        // With its id, as a step's check: the project's Docker rules apply.
        project,
        command,
        logPath,
        timeoutMs: deps.timeoutMs,
        env: deps.sessionEnv(project),
        rules: listPermissionRules(db, project.id, null),
        checkouts: allCheckouts(db),
        signal,
        onSpawn: (pid) => {
          recording = deps.identifyProcess(pid).then((start) => {
            if (start !== null)
              deps.state.write((w) => {
                setPassCheckPid(w, passId, { pid, start });
              });
          });
        },
      });
    } finally {
      // The pid is cleared only once its recording has landed, so a late one never outlives it.
      await recording.catch(() => undefined);
      deps.state.write((w) => {
        setPassCheckPid(w, passId, null);
      });
    }
    if (result.aborted || stopped()) return;
    const turnIds = turns.map((t) => t.turnId);
    if (result.exitCode === 0) {
      whileOpen(passId, (w) => {
        markTurnsChecked(w, turnIds, PassTurnCheck.Passed);
        clearPassNotice(w, passId, TURN_CHECK_NOTICE);
      });
      return;
    }
    if ((result.exitCode === UNSTARTED_EXIT && !result.timedOut) || result.dockerRefused === true) {
      tell(passId, unrunText(result));
      return;
    }
    const output = await outputOf(result);
    const changed = await deps.git.changedPaths(project.repoPath);
    if (stopped()) return;
    whileOpen(passId, (w) => {
      const pages = listPassTasks(w.tx, passId).map((task) => ({
        taskId: task.id,
        areas: passHeldAreas(project.areas, task),
        signedOff:
          task.workstreamId !== null &&
          getWorkstream(w.tx, task.workstreamId).state === WorkstreamState.Done,
        working: openPassTurn(w.tx, task.id) !== undefined,
      }));
      const { named, threads } = checkTargets({
        output,
        changed,
        roots: rootsOf(project.repoPath),
        areas: project.areas,
        pages,
        ran: turns.map((t) => t.taskId),
      });
      const offer = (line: string): string =>
        checkOffer({
          line,
          command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          output,
        });
      for (const target of threads) {
        withdrawOlderOffers(w, target.taskId);
        const line = checkNoticeLine(target.paths);
        const notice = insertSystemNotice(w, target.taskId, line);
        offerToAgent(w, notice.id, offer(line));
      }
      markTurnsChecked(w, turnIds, PassTurnCheck.Failed);
      setPassNotice(w, passId, {
        id: TURN_CHECK_NOTICE,
        kind: PassNoticeKind.TurnCheck,
        text: offer(checkNoticeLine(named)),
        sendable: true,
        cardId: null,
        at: w.now,
      });
    });
  }

  /** A newer failure replaces the task's older check offers: only the latest is sent. */
  function withdrawOlderOffers(w: WriteContext, taskId: TaskId): void {
    for (const said of listTaskThread(w.tx, taskId))
      if (
        said.author === TaskMessageAuthor.System &&
        said.sendable &&
        said.body.startsWith(CHECK_FAILED)
      )
        takeOffer(w, said.id);
  }

  async function stop(passId: PassId): Promise<void> {
    const live = runs.get(passId);
    apply(passId, { kind: 'stop' });
    await live?.done;
  }

  return {
    ask(input) {
      apply(input.passId, {
        kind: 'ready',
        turn: { taskId: input.taskId, turnId: input.turnId },
        checks: checkedProject(input.passId) !== null,
      });
    },
    stop,
    async stopAll() {
      await Promise.all([...queues.keys()].map(stop));
    },
  };
}

/**
 * Asks for a check when a page's turn ends Ready (in the runner or in recovery's finish), and stops
 * a pass's check once the pass is no longer open.
 */
function subscribeTurnChecks(bus: EventBus, db: DbReader, checks: TurnChecks): () => void {
  return bus.subscribe((event) => {
    if (event.type === EventType.PassPageReady) {
      const passId = PassId.safeParse(event.entityId);
      const taskId = TaskId.safeParse(event.data['taskId']);
      const turnId = PassTurnId.safeParse(event.data['turnId']);
      if (passId.success && taskId.success && turnId.success)
        checks.ask({ passId: passId.data, taskId: taskId.data, turnId: turnId.data });
      return;
    }
    if (event.type !== EventType.PassChanged) return;
    const passId = PassId.safeParse(event.entityId);
    if (passId.success && findPass(db, passId.data)?.state !== PassState.Open)
      void checks.stop(passId.data);
  });
}

/**
 * The close's and Abandon's stop of what checks a pass (`PassShipDeps.stopPassChecks`): its pull
 * request's gate and review, then its turn check, each waited for.
 */
export function withTurnChecks<S extends { stopPassChecks(passId: PassId): Promise<void> }>(
  ship: S,
  checks: Pick<TurnChecks, 'stop'>,
): S {
  return {
    ...ship,
    async stopPassChecks(passId: PassId) {
      await ship.stopPassChecks(passId);
      await checks.stop(passId);
    },
  };
}

/** Ends a recorded process group only while its start time still matches (`recovery/processes.ts`). */
export interface CheckTerminator {
  terminate(target: {
    readonly pid: number;
    readonly startedAt: string;
    readonly group?: boolean;
  }): Promise<unknown>;
}

/**
 * At start-up, before recovery settles any turn: stops every turn check a stopped daemon left
 * running and clears its pid, then follows Ready turns. Recovery's own Ready turns are checked, and
 * a new check never runs beside a left one or takes its pid's place.
 */
export async function startTurnChecks(
  deps: TurnChecksDeps & { readonly bus: EventBus; readonly processes: CheckTerminator },
): Promise<{ readonly checks: TurnChecks; readonly unsubscribe: () => void }> {
  for (const left of listPassCheckPids(deps.state.db)) {
    await deps.processes.terminate({ pid: left.pid, startedAt: left.start, group: true });
    deps.state.write((w) => {
      setPassCheckPid(w, left.passId, null);
    });
    deps.logger.info({ passId: left.passId }, 'stopped a turn check a stopped daemon left running');
  }
  const checks = createTurnChecks(deps);
  return { checks, unsubscribe: subscribeTurnChecks(deps.bus, deps.state.db, checks) };
}
