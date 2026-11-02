import {
  GoalAdoptError,
  GoalDigestDto,
  GoalDto,
  GoalListDto,
  type GoalAdoptIssue,
  type GoalId,
  type ProjectId,
} from '@10db/contracts';
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

/** What the daemon made of a brief: the new goal, or every reason it refused. */
export type AdoptResult =
  | { readonly kind: 'adopted'; readonly goal: GoalDto }
  | { readonly kind: 'refused'; readonly errors: readonly GoalAdoptIssue[] };

/**
 * Adopts the plan at `path`. A refused brief is an answer, not an error: the form shows its list.
 * Anything else the daemon says (an unreadable file, a server fault) rejects the mutation.
 */
export function useAdoptGoal(projectId: ProjectId | null) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (path: string): Promise<AdoptResult> => {
      if (!projectId) throw new Error('Choose a project first.');
      const res = await client.projects[':projectId'].goals.adopt.$post({
        param: { projectId },
        json: { path, dryRun: false },
      });
      if (res.status === 400) {
        const body: unknown = await res
          .clone()
          .json()
          .catch(() => null);
        const refusal = GoalAdoptError.safeParse(body);
        if (refusal.success) return { kind: 'refused', errors: refusal.data.errors };
      }
      return { kind: 'adopted', goal: await readJson(res, GoalDto) };
    },
    onSuccess: (result) => {
      if (result.kind === 'adopted') void queryClient.invalidateQueries({ queryKey: goalKeys.all });
    },
  });
}
