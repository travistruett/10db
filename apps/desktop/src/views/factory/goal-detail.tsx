import type { GoalDigestDto, TaskId, WorkstreamDto, WorkstreamId } from '@10db/contracts';
import { Divider, Stack } from '@mantine/core';
import { useBatches, useWorkstreams } from '../../daemon/queries';
import { useSelectedProject } from '../../shell/selected-project';
import { GoalDigest, type OpenedDigest } from './goal-digest';
import { GoalPullRequests } from './goal-pull-requests';
import { GoalSessions } from './goal-sessions';

/** The newest workstream of each task, oldest task first: a task's earlier runs are its history. */
function latestPerTask(workstreams: readonly WorkstreamDto[]): WorkstreamDto[] {
  const latest = new Map<TaskId, WorkstreamDto>();
  for (const ws of workstreams) {
    const seen = latest.get(ws.taskId);
    if (!seen || seen.createdAt < ws.createdAt) latest.set(ws.taskId, ws);
  }
  return [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The workstreams `select` keeps, and whether they are still loading or failed to load. */
function useSessions(select: (ws: WorkstreamDto) => boolean) {
  const all = useWorkstreams({ active: false });
  return {
    all: (all.data ?? []).filter(select),
    loading: all.isPending,
    error: all.isError ? all.error.message : null,
  };
}

export interface GoalDetailProps {
  /** The goal's current state, from the list. */
  readonly live: GoalDigestDto;
  readonly taskIds: readonly TaskId[];
  readonly opened: OpenedDigest;
}

/**
 * An expanded goal: its digest, then its Sessions (the workstreams of its tasks) and its Pull
 * requests (the batches they ran in). One self-contained component, so it can move into a drawer
 * or a page.
 */
export function GoalDetail({ live, taskIds, opened }: GoalDetailProps) {
  const { project } = useSelectedProject();
  const sessions = useSessions((ws) => taskIds.includes(ws.taskId));
  const batches = useBatches(project?.id ?? null);
  const batchIds = new Set(sessions.all.flatMap((ws) => (ws.batchId ? [ws.batchId] : [])));

  return (
    <Stack gap="md">
      <GoalDigest live={live} opened={opened} />
      <Divider />
      <GoalSessions
        goalId={live.goalId}
        workstreams={latestPerTask(sessions.all)}
        loading={sessions.loading}
        error={sessions.error}
      />
      <Divider />
      <GoalPullRequests
        batches={(batches.data ?? []).filter((batch) => batchIds.has(batch.id))}
        error={batches.isError ? batches.error.message : null}
      />
    </Stack>
  );
}

/** The expanded Not in a goal row: only the sessions of tasks with no goal that are running or failed. */
export function UngroupedDetail({
  workstreamIds,
}: {
  readonly workstreamIds: readonly WorkstreamId[];
}) {
  const sessions = useSessions((ws) => workstreamIds.includes(ws.id));
  return (
    <GoalSessions
      goalId={null}
      workstreams={sessions.all}
      loading={sessions.loading}
      error={sessions.error}
    />
  );
}
