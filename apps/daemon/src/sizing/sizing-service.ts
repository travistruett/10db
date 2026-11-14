import {
  EventType,
  JudgeDecision,
  JudgeOutcome,
  RigorSource,
  TaskId,
  TaskKindSource,
  TaskStatus,
  type JudgeCallId,
  type TaskDto,
  type TaskKind,
} from '@10db/contracts';
import {
  applyTaskSizing,
  getGoal,
  getJudgeConfig,
  getProject,
  listKinds,
  placementRuleMoves,
  readTaskSizing,
  recordJudgeOutcome,
  type DbReader,
  type Placement,
  type TaskSizingState,
} from '@10db/db';
import type { Clock } from '../clock';
import type { EventBus, StateStore } from '../events';
import type { Judge, JudgeAnswer } from '../judge';
import type { Logger } from '../log';
import { placementAfterEdit } from '../placement';
import { sizingFingerprint } from './fingerprint';
import { kindRequest, readKind, readRigor, rigorRequest, sizingState } from './judge-sizing';
import { sizeByRules } from './rules';

/** Judge calls run for this many tasks at a time; the rest wait their turn, oldest first. */
const MAX_TASKS_AT_ONCE = 4;
/** How long a start waits for sizing still in flight before it goes on with the rules' answer. */
export const SIZING_WAIT_MS = 4_000;

export interface SizingDeps {
  readonly state: StateStore;
  readonly bus: EventBus;
  readonly judge: Judge;
  readonly clock: Clock;
  readonly log: Logger;
  /** What refuses a change of where the task works while its join into a batch is pending; null when none. */
  readonly joiningProblem: (taskId: TaskId) => string | null;
}

export interface SizingService {
  /**
   * Resolves when the sizing in flight for these tasks has ended, or after `timeoutMs` on the injected
   * clock, whichever is first. Never rejects. A start from the Board, the API or the builder's MCP
   * awaits this before it reads anything.
   */
  settled(taskIds: readonly TaskId[], timeoutMs?: number): Promise<void>;
  /** Stops listening for task events and cuts the calls in flight short. */
  stop(): void;
}

/** One task's judge calls: queued, then running, then applied. */
interface Job {
  readonly taskId: TaskId;
  readonly fingerprint: string;
  readonly controller: AbortController;
  started: boolean;
  readonly done: Promise<void>;
  finish(): void;
}

const PINNED_KIND_SOURCES: readonly TaskKind['source'][] = [
  TaskKindSource.Builder,
  TaskKindSource.Agent,
];

const rigorPinned = (task: TaskSizingState): boolean =>
  task.rigorSource === RigorSource.Builder || task.rigorSource === RigorSource.Agent;

/** What a judge answer depends on besides the text: the pins that decided what was asked. */
const pinsOf = (task: TaskSizingState): string =>
  JSON.stringify([
    rigorPinned(task),
    task.kinds
      .filter((k) => PINNED_KIND_SOURCES.includes(k.source))
      .map((k) => k.key)
      .sort(),
    [...task.kindsOff].sort(),
  ]);

/** Whether a task can be sized at all: open, never started and not a Workbench page. */
function sizable(task: TaskSizingState): boolean {
  return task.status === TaskStatus.Open && !task.started && task.passId === null;
}

export function createSizingService(deps: SizingDeps): SizingService {
  /**
   * Where the task works once its kinds are `kinds`: the placement rule's answer, which a pending join
   * into a batch can't take, so a move the rule would make then is left for later.
   */
  function placementFor(db: DbReader) {
    return (task: TaskDto, kinds: readonly TaskKind[]): Placement | undefined => {
      const proposed = placementAfterEdit({
        project: getProject(db, task.projectId),
        areas: task.areas,
        kinds,
        known: listKinds(db),
      });
      if (deps.joiningProblem(task.id) !== null && placementRuleMoves(task, proposed))
        return undefined;
      return proposed;
    };
  }

  /**
   * The rules' answer for a task whose text changed, in one write; the text's fingerprint, or null when
   * there was nothing to size.
   */
  function sizeByRulesNow(taskId: TaskId): string | null {
    const task = readTaskSizing(deps.state.db, taskId);
    if (task === null || !sizable(task)) return null;
    const fingerprint = sizingFingerprint(task);
    if (fingerprint === task.sizedFor) return null;
    const applied = deps.state.write((ctx) => {
      const sizing = sizeByRules({ task, kinds: listKinds(ctx.tx) });
      return (
        applyTaskSizing(
          ctx,
          taskId,
          {
            fingerprint,
            kinds: sizing.kinds,
            clearJudged: true,
            sizingCalls: { rigor: null, kinds: {} },
          },
          placementFor(ctx.tx),
        ) !== null
      );
    });
    return applied ? fingerprint : null;
  }

  const inflight = new Map<TaskId, Job>();
  const queue: Job[] = [];
  let running = 0;

  /** Whether the judge can be asked at all: on, with an account, and a decision to ask. */
  function judgeAvailable(): boolean {
    if (deps.judge.off) return false;
    const config = getJudgeConfig(deps.state.db);
    return config.enabled && config.accountId !== null;
  }

  /** Asks the judge about the task as it stands and applies the answers in one write. */
  async function judgeTask(job: Job): Promise<void> {
    const asked = readTaskSizing(deps.state.db, job.taskId);
    if (asked === null || !sizable(asked) || sizingFingerprint(asked) !== job.fingerprint) return;
    const config = getJudgeConfig(deps.state.db);
    const known = listKinds(deps.state.db);
    const implied = new Set(
      sizeByRules({ task: asked, kinds: known })
        .kinds.filter((k) => k.source === TaskKindSource.Rules)
        .map((k) => k.key),
    );
    const held = new Set(
      asked.kinds.filter((k) => PINNED_KIND_SOURCES.includes(k.source)).map((k) => k.key),
    );
    const askRigor = !rigorPinned(asked) && config.decisions[JudgeDecision.TaskRigor].enabled;
    const askKinds = config.decisions[JudgeDecision.TaskKinds].enabled
      ? known.filter(
          (k) => !held.has(k.key) && !asked.kindsOff.includes(k.key) && !implied.has(k.key),
        )
      : [];
    if (!askRigor && askKinds.length === 0) return;

    const goal = asked.goalId === null ? null : getGoal(deps.state.db, asked.goalId).title;
    const text = {
      state: sizingState(asked, goal),
      taskId: job.taskId,
      signal: job.controller.signal,
    };
    const [rigorAnswer, ...kindAnswers] = await Promise.all([
      askRigor ? deps.judge.choose(rigorRequest(text)) : Promise.resolve(null),
      ...askKinds.map((kind) => deps.judge.choose(kindRequest(kind, text))),
    ]);

    deps.state.write((ctx) => {
      const now = readTaskSizing(ctx.tx, job.taskId);
      // The answers were asked for this text and these pins, of a task that has not started: anything
      // else and they are for a task that is no longer the one asked about.
      if (
        now === null ||
        !sizable(now) ||
        sizingFingerprint(now) !== job.fingerprint ||
        pinsOf(now) !== pinsOf(asked)
      ) {
        for (const answer of [rigorAnswer, ...kindAnswers])
          if (answer?.kind === 'answered')
            recordJudgeOutcome(ctx, answer.callId, JudgeOutcome.Stopped);
        return;
      }
      const rigor =
        rigorAnswer === null
          ? null
          : readRigor(rigorAnswer, config.decisions[JudgeDecision.TaskRigor].floor);
      const judged: TaskKind[] = [];
      const calls: Record<string, JudgeCallId> = {};
      askKinds.forEach((kind, i) => {
        const answer: JudgeAnswer | undefined = kindAnswers[i];
        const read =
          answer === undefined
            ? null
            : readKind(answer, config.decisions[JudgeDecision.TaskKinds].floor);
        if (read === null) return;
        calls[kind.key] = read.callId;
        if (read.touches) judged.push({ key: kind.key, source: TaskKindSource.Judge });
      });
      const sized = sizeByRules({
        task: now,
        kinds: listKinds(ctx.tx),
        judged: {
          kinds: judged,
          ...(rigor === null ? {} : { rigor: { value: rigor.value, reason: rigor.reason } }),
        },
      });
      applyTaskSizing(
        ctx,
        job.taskId,
        {
          fingerprint: job.fingerprint,
          kinds: sized.kinds,
          ...(sized.rigor === undefined
            ? {}
            : { rigor: sized.rigor.value, rigorReason: sized.rigor.reason }),
          sizingCalls: { rigor: rigor?.callId ?? null, kinds: calls },
        },
        placementFor(ctx.tx),
      );
    });
  }

  function pump(): void {
    while (running < MAX_TASKS_AT_ONCE) {
      const job = queue.shift();
      if (job === undefined) return;
      job.started = true;
      running += 1;
      judgeTask(job)
        .catch((error: unknown) => {
          deps.log.error({ err: error, taskId: job.taskId }, 'could not size a task by the judge');
        })
        .finally(() => {
          running -= 1;
          if (inflight.get(job.taskId) === job) inflight.delete(job.taskId);
          job.finish();
          pump();
        });
    }
  }

  /** Queues the judge for a task whose rules have just run; an older call for older text is cut short. */
  function enqueue(taskId: TaskId, fingerprint: string): void {
    const older = inflight.get(taskId);
    if (older !== undefined) {
      older.controller.abort();
      const at = queue.indexOf(older);
      if (at >= 0) {
        queue.splice(at, 1);
        older.finish();
      }
    }
    let finish = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job: Job = {
      taskId,
      fingerprint,
      controller: new AbortController(),
      started: false,
      done,
      finish,
    };
    inflight.set(taskId, job);
    queue.push(job);
    pump();
  }

  const unsubscribe = deps.bus.subscribe((event) => {
    if (event.type !== EventType.TaskCreated && event.type !== EventType.TaskChanged) return;
    const id = TaskId.safeParse(event.entityId);
    if (!id.success) return;
    try {
      const fingerprint = sizeByRulesNow(id.data);
      if (fingerprint !== null && judgeAvailable()) enqueue(id.data, fingerprint);
    } catch (error) {
      deps.log.error({ err: error, taskId: id.data }, 'could not size a task');
    }
  });

  return {
    settled(taskIds, timeoutMs = SIZING_WAIT_MS) {
      const pending = taskIds.flatMap((id) => inflight.get(id)?.done ?? []);
      if (pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = deps.clock.setTimeout(resolve, timeoutMs);
        void Promise.all(pending).then(() => {
          timer.cancel();
          resolve();
        });
      });
    },
    stop() {
      unsubscribe();
      for (const job of inflight.values()) job.controller.abort();
    },
  };
}
