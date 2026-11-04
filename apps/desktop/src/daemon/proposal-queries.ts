import { SmallProposalLimitDto, type ProjectId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

const smallLimitKey = (projectId: ProjectId) => ['proposals', 'small-limit', projectId] as const;

/** The size up to which 10db files a lane's proposal to the Icebox without a card (zero: never). */
export function useSmallProposalLimit(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: smallLimitKey(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['small-proposal-limit'].$get({ param: { projectId } }),
        SmallProposalLimitDto,
      ),
  });
}

export function useSetSmallProposalLimit(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (limit: number) =>
      readJson(
        await client.projects[':projectId']['small-proposal-limit'].$put({
          param: { projectId },
          json: { limit },
        }),
        SmallProposalLimitDto,
      ),
    onSuccess: (setting) => {
      queryClient.setQueryData(smallLimitKey(projectId), setting);
    },
  });
}
