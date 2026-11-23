import {
  ChatDto,
  FigmaSignInsDto,
  LinearSignInsDto,
  ProjectIntegrationsDto,
  type LinearReporterSettings,
  type ProjectId,
  type ProjectIntegrationsInput,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatKeys } from './chat-queries';
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

/** From Linear: a Plan session that imports issues through the project's account. */
export function useImportFromLinear(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      readJson(
        await client.projects[':projectId'].integrations.linear.import.$post({
          param: { projectId },
        }),
        ChatDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.all }),
  });
}

/** Report To Linear and How To Update Linear: saves the project's reporter settings. */
export function useSetLinearReporter(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LinearReporterSettings) =>
      readJson(
        await client.projects[':projectId'].integrations.linear.$put({
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

/** How each agent account reaches Figma, from what the daemon has already read. */
export function useFigmaSignIns() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ['sign-ins', 'figma'],
    queryFn: async () => readJson(await client.settings['sign-ins'].figma.$get(), FigmaSignInsDto),
  });
}
