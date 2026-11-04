import { HumanTouchDto, type ProjectId } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

export const humanTouchKeys = {
  all: ['human-touch'],
  project: (projectId: ProjectId) => ['human-touch', projectId] as const,
} as const;

/** How often a person was needed in the project over the last 14 days; cards and runs move it. */
export function useHumanTouch(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId ? humanTouchKeys.project(projectId) : ['human-touch', 'none'],
    queryFn: async () =>
      projectId
        ? readJson(
            await client.projects[':projectId']['human-touch'].$get({ param: { projectId } }),
            HumanTouchDto,
          )
        : { days: [] },
    enabled: projectId !== null,
  });
}
