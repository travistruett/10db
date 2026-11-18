import { CardTypesDto, type ProjectId } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

export const cardTypesKeys = {
  all: ['card-types'],
  project: (projectId: ProjectId) => ['card-types', projectId] as const,
} as const;

/** What became of each Inbox card type the project raised over the last 7 and 30 days; cards move it. */
export function useCardTypes(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId ? cardTypesKeys.project(projectId) : ['card-types', 'none'],
    queryFn: async () =>
      projectId
        ? readJson(
            await client.projects[':projectId']['card-types'].$get({ param: { projectId } }),
            CardTypesDto,
          )
        : { types: [] },
    enabled: projectId !== null,
  });
}
