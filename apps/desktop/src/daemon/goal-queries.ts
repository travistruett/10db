import { GoalDigestDto, GoalDto, GoalListDto, type GoalId, type ProjectId } from '@10db/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson, type DaemonClient } from './client';
import { useDaemon } from './provider';

export const goalKeys = {
  all: ['goals'],
  list: (projectId: ProjectId) => ['goals', projectId] as const,
  one: (goalId: GoalId | null) => ['goals', 'one', goalId] as const,
} as const;

/**
 * One project's goals with their digests, as a query a view can read for several projects at once
 * (`useQueries`). Reading it leaves every "last opened" mark alone, so the list can refresh on each event
 * without closing a goal's window.
 */
export function goalsQueryOptions(client: DaemonClient, projectId: ProjectId) {
  return queryOptions({
    queryKey: goalKeys.list(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].goals.$get({ param: { projectId } }),
        GoalListDto,
      ),
  });
}

/** One project's goals (`goalsQueryOptions`); none while no project is chosen. */
export function useGoals(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId ? goalKeys.list(projectId) : ['goals', 'none'],
    queryFn: async () =>
      projectId
        ? readJson(
            await client.projects[':projectId'].goals.$get({ param: { projectId } }),
            GoalListDto,
          )
        : { goals: [], ungrouped: null },
    enabled: projectId !== null,
  });
}

/** One goal on its own, for a page that knows only the goal's id; its project's list holds the rest. */
export function useGoal(goalId: GoalId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: goalKeys.one(goalId),
    queryFn: async () =>
      goalId === null
        ? null
        : readJson(await client.goals[':goalId'].$get({ param: { goalId } }), GoalDto),
    enabled: goalId !== null,
  });
}

/**
 * Opens a goal: the daemon answers the changes since the builder last opened it and moves that mark
 * to now. A query would repeat the read on a remount or a focus and find the window already closed,
 * so opening is a mutation, run once from the click.
 */
export function useOpenGoal() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (goalId: GoalId) =>
      readJson(await client.goals[':goalId'].digest.$get({ param: { goalId } }), GoalDigestDto),
    // The list counted this goal's news from the old mark; the move makes it zero.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: goalKeys.all }),
  });
}
