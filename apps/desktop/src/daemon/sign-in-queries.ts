import {
  ChatDto,
  LinearSignInsDto,
  ProjectIntegrationsDto,
  ProjectLinearDto,
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
    // A Linear check runs in a session of its own; the card follows it until it links or refuses.
    refetchInterval: (query) =>
      query.state.data?.linear.check?.state === 'checking' ? 2000 : false,
  });
}

/** Link: opens the session that checks the team key against the builder's Linear sign-in. */
export function useCheckLinearTeam(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (teamKey: string) =>
      readJson(
        await client.projects[':projectId'].integrations.linear.check.$post({
          param: { projectId },
          json: { teamKey },
        }),
        ProjectLinearDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectIntegrationsKey(projectId) }),
  });
}

/** From Linear: a Plan session that imports the linked team's issues. */
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

/** Cancel: ends the Linear check in flight. */
export function useCancelLinearCheck(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      readJson(
        await client.projects[':projectId'].integrations.linear.check.$delete({
          param: { projectId },
        }),
        ProjectLinearDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectIntegrationsKey(projectId) }),
  });
}

/** Unlink: clears the project's Linear binding. */
export function useUnlinkLinear(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      readJson(
        await client.projects[':projectId'].integrations.linear.$delete({ param: { projectId } }),
        ProjectLinearDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectIntegrationsKey(projectId) }),
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
