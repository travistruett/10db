import {
  BatchState,
  ConflictError,
  UNFINISHED_BATCH_STATES,
  type BatchDto,
  type LandingGroupId,
  type Notice,
  type TaskDto,
} from '@10db/contracts';
import { getLandingGroup, landingBatches, type DbReader } from '@10db/db';
import { landingNotices } from './notices';

// Shape spec §10.4. A landing group's tasks land in one pull request: a start puts the ones it
// starts together in one batch (`groupByDependency`), and a task started later joins the landing's
// open batch, or makes a new one with a notice saying why once that batch has shipped.

/** Where a start puts its tasks that belong to a landing. */
export interface LandingPlan {
  /** Tasks whose landing already has an open batch, by batch: they join it. */
  readonly joins: readonly { readonly batch: BatchDto; readonly tasks: readonly TaskDto[] }[];
  /** Everything else, in the order given: started by the usual rules. */
  readonly rest: readonly TaskDto[];
  /** The title of each landing among `rest`, which names the batch they make. */
  readonly titles: ReadonlyMap<LandingGroupId, string>;
}

/**
 * Splits a start's tasks into those that join their landing's open batch and the rest. A landing
 * whose batch is cutting, shipping or failed can't take a task yet, and the start is refused saying
 * so; a landing whose batch has shipped starts the task in a batch of its own. Tasks of one landing
 * that would start in different places are refused too, since they could not share a pull request.
 */
export function planLandings(db: DbReader, tasks: readonly TaskDto[]): LandingPlan {
  const joins = new Map<BatchDto['id'], { batch: BatchDto; tasks: TaskDto[] }>();
  const rest: TaskDto[] = [];
  const titles = new Map<LandingGroupId, string>();
  for (const task of tasks) {
    const groupId = task.landingGroupId;
    if (groupId === null || groupId === undefined) {
      rest.push(task);
      continue;
    }
    const group = getLandingGroup(db, groupId);
    const open = landingBatches(db, groupId).find((b) => UNFINISHED_BATCH_STATES.includes(b.state));
    if (open === undefined) {
      titles.set(groupId, group.title);
      rest.push(task);
      continue;
    }
    if (open.state !== BatchState.Open)
      throw new ConflictError(
        `${task.title} lands with ${group.title}, whose batch "${open.title}" is ${open.state.toLowerCase()}; start it once that batch is open or has shipped`,
      );
    const joining = joins.get(open.id) ?? { batch: open, tasks: [] };
    joining.tasks.push(task);
    joins.set(open.id, joining);
  }
  // One pull request, so one place: a landing is cut in the project's checkout or in a copy, not both.
  const placed = new Map<LandingGroupId, TaskDto>();
  for (const task of rest) {
    const groupId = task.landingGroupId;
    if (groupId === null || groupId === undefined) continue;
    const first = placed.get(groupId);
    if (first === undefined) placed.set(groupId, task);
    else if (first.workspaceMode !== task.workspaceMode)
      throw new ConflictError(
        `${first.title} and ${task.title} are in the landing ${titles.get(groupId) ?? ''} and share a pull request, but they work in different places (${first.title} in ${placeOf(first)}, ${task.title} in ${placeOf(task)}). Give them the same place, or start them one after the other.`,
      );
  }
  return { joins: [...joins.values()], rest, titles };
}

function placeOf(task: TaskDto): string {
  return task.workspaceMode === 'shared' ? 'your folder' : 'a separate copy';
}

/**
 * The notice for a batch that a landing's task starts anew because its landing's earlier batch has
 * shipped; null when none of the tasks belongs to a landing that has shipped.
 */
export function shippedLandingNotice(db: DbReader, tasks: readonly TaskDto[]): Notice | null {
  for (const task of tasks) {
    const groupId = task.landingGroupId;
    if (groupId === null || groupId === undefined) continue;
    const shipped = landingBatches(db, groupId).find((b) => b.state === BatchState.Shipped);
    if (shipped !== undefined)
      return landingNotices.shipped(getLandingGroup(db, groupId).title, shipped.title);
  }
  return null;
}
