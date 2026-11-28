import { Delivery, type ProjectViewDto, type TaskId, type WorkstreamDto } from '@10db/contracts';
import {
  useBatches,
  useBoardColumns,
  useTask,
  useTasks,
  useWorkstreams,
} from '../../daemon/queries';
import { withFixTaskTitles } from './ci-line';
import { boardRun } from './pass-page';
import { queuePlaces } from './queue-place';
import { columnNameOf, TaskDrawer } from './task-drawer';

export interface ProjectTaskDrawerProps {
  readonly project: ProjectViewDto;
  readonly taskId: TaskId;
  /** Starts the task afresh, where the view that holds the drawer can say how the start went. */
  readonly onStart?: () => void;
  /** Asks the holder's confirm before the run is cancelled. */
  readonly onCancelRun?: (workstream: WorkstreamDto) => void;
  readonly onOpenWorkbench?: () => void;
  /** Opens the task on the Board, from a view that is not the Board. */
  readonly onOpenBoard?: () => void;
  readonly onClose: () => void;
}

/**
 * A task's drawer from its project's reads alone, so the Board and Factory open the same drawer: the task,
 * its latest run and batch, its column's name, its place in line and the project's settings. Shows nothing
 * until the task is in the project's list and read whole.
 */
export function ProjectTaskDrawer({
  project,
  taskId,
  onStart,
  onCancelRun,
  onOpenWorkbench,
  onOpenBoard,
  onClose,
}: ProjectTaskDrawerProps) {
  const tasks = useTasks(project.id).data ?? [];
  const columns = useBoardColumns(project.id).data ?? [];
  const workstreams = useWorkstreams({ active: false }).data ?? [];
  const batchList = useBatches(project.id).data ?? [];
  // The list's task has no description or criteria; the drawer shows and edits the task read whole.
  const task = useTask(taskId).data;
  if (task === undefined || !tasks.some((t) => t.id === taskId)) return null;
  const workstreamById = new Map(workstreams.map((ws) => [ws.id, ws]));
  const batchById = new Map(batchList.map((b) => [b.id, b]));
  const ws = task.workstreamId ? workstreamById.get(task.workstreamId) : undefined;
  const { workstream, batch } = boardRun(
    task,
    ws,
    ws?.batchId ? batchById.get(ws.batchId) : undefined,
  );
  // A CI fix batch finds the root that holds the pull request's required checks among all of them.
  const batches = withFixTaskTitles(batchList, workstreams);
  const place = workstream ? queuePlaces(workstreams, batchById).get(workstream.id) : undefined;
  const humanColumns = new Map(columns.map((c) => [c.id, c.name] as const));
  // Local delivery has no pull request to place.
  const pullRequests = project.delivery === Delivery.PullRequest;
  return (
    <TaskDrawer
      key={task.id}
      task={task}
      columnName={columnNameOf(task, humanColumns)}
      peers={new Map(tasks.map((t) => [t.id, t]))}
      {...(workstream ? { workstream } : {})}
      {...(batch ? { batch } : {})}
      batches={batches}
      workstreams={workstreams}
      {...(place !== undefined ? { place } : {})}
      placementEditable={pullRequests || project.localCopies}
      gateCommand={project.gateCommand}
      accountId={project.accountId}
      areaNames={project.areas.map((area) => area.name)}
      {...(pullRequests ? { pullRequestBase: project.baseBranch } : {})}
      {...(onStart ? { onStart } : {})}
      {...(onCancelRun ? { onCancelRun } : {})}
      offersPlanSession
      {...(onOpenWorkbench ? { onOpenWorkbench } : {})}
      {...(onOpenBoard ? { onOpenBoard } : {})}
      onClose={onClose}
    />
  );
}
