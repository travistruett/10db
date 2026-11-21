import type { ProjectId, ShapeProposalDto, TaskDto } from '@10db/contracts';
import { useTasks, useWorkstreams } from '../../../daemon/queries';
import { taskLiveWord, type LiveWord } from './live-state';

/** What an accepted goal or task row says about its tasks now, from the caches the Board reads. */
export function useLiveWords(
  row: ShapeProposalDto,
  projectId: ProjectId | null,
): {
  readonly words: readonly LiveWord[];
  readonly tasks: readonly (TaskDto | undefined)[];
} | null {
  const tasks = useTasks(projectId);
  const workstreams = useWorkstreams({ active: false });
  if ((row.kind !== 'goal' && row.kind !== 'task') || row.converted === null) return null;
  const byId = new Map((tasks.data ?? []).map((t) => [t.id, t]));
  const runs = new Map((workstreams.data ?? []).map((w) => [w.id, w]));
  const found = row.converted.taskIds.map((id) => byId.get(id));
  const words = found.map((task) =>
    taskLiveWord(task, task?.workstreamId == null ? undefined : runs.get(task.workstreamId)),
  );
  return { words, tasks: found };
}
