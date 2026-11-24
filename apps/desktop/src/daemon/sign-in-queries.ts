import {
  ChatDto,
  ConnectServiceDto,
  type ConnectableService,
  FigmaSignInsDto,
  LinearSignInsDto,
  ProjectIntegrationsDto,
  ProjectSlackSharingDto,
  SlackChannelsDto,
  type LinearReporterSettings,
  type ProjectId,
  type ProjectIntegrationsInput,
  type ProjectSlackSharingInput,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatKeys } from './chat-queries';
import { readJson } from './client';
import { SLACK_KEY } from './people';
import { useDaemon } from './provider';
import { trustKeys } from './trust-queries';

export const LINEAR_SIGN_INS_KEY = ['sign-ins', 'linear'] as const;
export const FIGMA_SIGN_INS_KEY = ['sign-ins', 'figma'] as const;

/** Under the Slack key, so a token change or a Slack connection event refetches a project's binding too. */
export const PROJECT_INTEGRATIONS_KEY = [...SLACK_KEY, 'project'] as const;
const projectIntegrationsKey = (projectId: ProjectId) =>
  [...PROJECT_INTEGRATIONS_KEY, projectId] as const;

const slackSharingKey = (projectId: ProjectId) => [...SLACK_KEY, 'sharing', projectId] as const;
const slackChannelsKey = (projectId: ProjectId) => [...SLACK_KEY, 'channels', projectId] as const;

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

/** Whether a pass's pictures go to Slack, and the channel they go to. */
export function useSlackSharing(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: slackSharingKey(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['slack-sharing'].$get({ param: { projectId } }),
        ProjectSlackSharingDto,
      ),
  });
}

export function useSetSlackSharing(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProjectSlackSharingInput) =>
      readJson(
        await client.projects[':projectId']['slack-sharing'].$put({
          param: { projectId },
          json: input,
        }),
        ProjectSlackSharingDto,
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(slackSharingKey(projectId), saved);
    },
  });
}

/** The channels of the project's workspace, or `missing_scope` when the token can't list them. */
export function useSlackChannels(projectId: ProjectId, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: slackChannelsKey(projectId),
    enabled,
    retry: false,
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].slack.channels.$get({ param: { projectId } }),
        SlackChannelsDto,
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

/** A project's Linear switch and update note: saves the project's reporter settings. */
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
      // A new workspace takes the channel back, and its channels are another list.
      void queryClient.invalidateQueries({ queryKey: slackSharingKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: slackChannelsKey(projectId) });
    },
  });
}

/** How each agent account reaches Linear, from what the daemon has already read. */
export function useLinearSignIns() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: LINEAR_SIGN_INS_KEY,
    queryFn: async () =>
      readJson(await client.settings['sign-ins'].linear.$get(), LinearSignInsDto),
    // Finishing a sign-in in Claude Code happens outside the app: reading again on return shows it.
    refetchOnWindowFocus: 'always',
  });
}

/** Connect: adds, approves and signs in a service's server for a project's account. */
export function useConnectService(service: ConnectableService) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: ProjectId) =>
      readJson(
        await client.settings.connect[':service'].$post({
          param: { service },
          json: { projectId },
        }),
        ConnectServiceDto,
      ),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: LINEAR_SIGN_INS_KEY }),
        queryClient.invalidateQueries({ queryKey: FIGMA_SIGN_INS_KEY }),
        queryClient.invalidateQueries({ queryKey: trustKeys.app }),
        queryClient.invalidateQueries({ queryKey: trustKeys.signIns }),
      ]);
    },
  });
}

/** How each agent account reaches Figma, from what the daemon has already read. */
export function useFigmaSignIns() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: FIGMA_SIGN_INS_KEY,
    queryFn: async () => readJson(await client.settings['sign-ins'].figma.$get(), FigmaSignInsDto),
    // Finishing a sign-in in Claude Code happens outside the app: reading again on return shows it.
    refetchOnWindowFocus: 'always',
  });
}
