import {
  GoalAdoptError,
  GoalDto,
  GoalListDto,
  type GoalAdoptIssue,
  type ProjectId,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

export const goalKeys = {
  all: ['goals'],
  list: (projectId: ProjectId) => ['goals', projectId] as const,
} as const;

/** The project's goals with their digests, read without marking any of them seen. */
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
