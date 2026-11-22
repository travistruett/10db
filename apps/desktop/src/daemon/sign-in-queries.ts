import {
  LinearSignInsDto,
  ProjectIntegrationsDto,
  type ProjectId,
  type ProjectIntegrationsInput,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { SLACK_KEY } from './people';
import { useDaemon } from './provider';

/** Under the Slack key, so a token change or a Slack connection event refetches a project's binding too. */
const projectIntegrationsKey = (projectId: ProjectId) =>
  [...SLACK_KEY, 'project', projectId] as const;

/** The GitHub login a project uses and its Slack workspace. */
export function useProjectIntegrations(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectIntegrationsKey(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].integrations.$get({ param: { projectId } }),
        ProjectIntegrationsDto,
      ),
  });
}

/** Binds the project to a signed-in Slack workspace, or turns Slack off for it with a null team. */
export function useSetProjectIntegrations(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProjectIntegrationsInput) =>
      readJson(
        await client.projects[':projectId'].integrations.$put({
          param: { projectId },
          json: input,
        }),
        ProjectIntegrationsDto,
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(projectIntegrationsKey(projectId), saved);
    },
  });
}

/** How each agent account reaches Linear, from what the daemon has already read. */
export function useLinearSignIns() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ['sign-ins', 'linear'],
    queryFn: async () =>
      readJson(await client.settings['sign-ins'].linear.$get(), LinearSignInsDto),
  });
}
