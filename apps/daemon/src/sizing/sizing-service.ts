import { EventType, TaskId, TaskStatus, type TaskDto, type TaskKind } from '@10db/contracts';
import {
  applyTaskSizing,
  getProject,
  listKinds,
  placementRuleMoves,
  readTaskSizing,
  type DbReader,
  type Placement,
  type TaskSizingState,
} from '@10db/db';
import type { Clock } from '../clock';
import type { EventBus, StateStore } from '../events';
import type { Judge } from '../judge';
import type { Logger } from '../log';
import { placementAfterEdit } from '../placement';
import { sizingFingerprint } from './fingerprint';
import { sizeByRules } from './rules';

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
  /** Stops listening for task events. */
  stop(): void;
}

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

  /** The rules' answer for a task whose text changed, in one write; false when there was nothing to size. */
  function sizeByRulesNow(taskId: TaskId): boolean {
    const task = readTaskSizing(deps.state.db, taskId);
    if (task === null || !sizable(task)) return false;
    const fingerprint = sizingFingerprint(task);
    if (fingerprint === task.sizedFor) return false;
    return deps.state.write((ctx) => {
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
  }

  const unsubscribe = deps.bus.subscribe((event) => {
    if (event.type !== EventType.TaskCreated && event.type !== EventType.TaskChanged) return;
    const id = TaskId.safeParse(event.entityId);
    if (!id.success) return;
    try {
      sizeByRulesNow(id.data);
    } catch (error) {
      deps.log.error({ err: error, taskId: id.data }, 'could not size a task by rules');
    }
  });

  return { stop: unsubscribe };
}
