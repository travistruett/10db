import { GoalDigestDto, GoalListDto, type GoalId, type ProjectId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

export const goalKeys = {
  all: ['goals'],
  list: (projectId: ProjectId) => ['goals', projectId] as const,
} as const;

/**
 * The project's goals with their digests and Not in a goal group. Reading it leaves every "last opened"
 * mark alone, so the list can refresh on each event without closing a goal's window.
 */
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
