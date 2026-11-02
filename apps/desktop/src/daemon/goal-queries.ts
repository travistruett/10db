import { GoalListDto, type ProjectId } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

/** Prefix of every project's goal list; events invalidate by it. */
export const GOALS_KEY = ['goals'] as const;

/**
 * The project's goals with their digests. Reading the list never advances a goal's "since you left"
 * mark, so the Board can show it freely.
 */
export function useGoals(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...GOALS_KEY, projectId],
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
