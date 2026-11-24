import {
  type ApproveYourMcpServer,
  LiveSystemProposalsDto,
  LiveSystemsDto,
  McpSignInsDto,
  RepoMcpServersDto,
  type SetRepoMcpVerdict,
  type StartMcpSignIn,
  ProjectTrustDto,
  TrustGrantDto,
  type TrustGrantId,
  TrustSettingsDto,
  type ProjectId,
  type TrustOverrides,
  type TrustSwitches,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

// Trust spec §9: what comes along into each session, app-wide and per project.

export const trustKeys = {
  app: ['trust'],
  project: (projectId: ProjectId) => ['trust', 'project', projectId],
  liveSystems: (projectId: ProjectId) => ['trust', 'live-systems', projectId],
  grants: (projectId: ProjectId) => ['trust', 'grants', projectId],
  proposals: (projectId: ProjectId) => ['trust', 'proposals', projectId],
  repoMcp: (projectId: ProjectId) => ['trust', 'repo-mcp', projectId],
  signIns: ['trust', 'mcp-sign-ins'],
} as const;

/** The app-wide switches and the builder's installed plugins. */
export function useTrust() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: trustKeys.app,
    queryFn: async () => readJson(await client.settings.trust.$get(), TrustSettingsDto),
  });
}

/**
 * Saves a change to the app-wide switches; every project's effective switches and preview follow them.
 * Changes run one at a time, each on the switches the daemon last saved, so a second quick change never
 * sends the first one's old value back.
 */
export function useSetTrust() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: 'trust' },
    mutationFn: async (change: (saved: TrustSwitches) => TrustSwitches) => {
      const saved = queryClient.getQueryData<TrustSettingsDto>(trustKeys.app)?.switches;
      if (saved === undefined) throw new Error('The trust settings have not loaded yet.');
      return readJson(await client.settings.trust.$put({ json: change(saved) }), TrustSettingsDto);
    },
    onSuccess: async (settings) => {
      queryClient.setQueryData(trustKeys.app, settings);
      await queryClient.invalidateQueries({ queryKey: ['trust', 'project'] });
    },
  });
}

/** Approves one of the builder's MCP servers as the page showed it; the daemon refuses a config that changed since. */
export function useApproveYourMcpServer() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ApproveYourMcpServer) =>
      readJson(
        await client.settings.trust['mcp-servers'].approve.$post({ json: input }),
        TrustSettingsDto,
      ),
    onSuccess: async (settings) => {
      queryClient.setQueryData(trustKeys.app, settings);
      await queryClient.invalidateQueries({ queryKey: ['trust', 'project'] });
    },
    onError: async () => {
      // A stale hash or a server that can't run: the list as it is now shows why.
      await queryClient.invalidateQueries({ queryKey: trustKeys.app });
    },
  });
}

/** Each Codex account's sign-in to each OAuth server, and the commands for Claude plan accounts. */
export function useMcpSignIns() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: trustKeys.signIns,
    queryFn: async () =>
      readJson(await client.settings.trust['mcp-sign-ins'].$get(), McpSignInsDto),
  });
}

/** Starts a Codex account's sign-in to one server, or opens its page again; the answer is the rows as they are then. */
export function useStartMcpSignIn() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    // An action, not a saved setting: a settings page's bar does not say Saved for it.
    meta: { quiet: true },
    mutationFn: async (input: StartMcpSignIn) =>
      readJson(await client.settings.trust['mcp-sign-ins'].$post({ json: input }), McpSignInsDto),
    onSuccess: (signIns) => {
      queryClient.setQueryData(trustKeys.signIns, signIns);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: trustKeys.signIns });
    },
  });
}

/** A project's overrides, the switches its sessions use, and what would come along. */
export function useProjectTrust(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: trustKeys.project(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].trust.$get({ param: { projectId } }),
        ProjectTrustDto,
      ),
  });
}

/** Saves a change to a project's overrides, one at a time, each on what the daemon last saved. */
export function useSetProjectTrust(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: `trust ${projectId}` },
    mutationFn: async (change: (saved: TrustOverrides) => TrustOverrides) => {
      const saved = queryClient.getQueryData<ProjectTrustDto>(
        trustKeys.project(projectId),
      )?.overrides;
      if (saved === undefined) throw new Error("The project's trust settings have not loaded yet.");
      return readJson(
        await client.projects[':projectId'].trust.$put({
          param: { projectId },
          json: change(saved),
        }),
        ProjectTrustDto,
      );
    },
    onSuccess: (trust) => {
      queryClient.setQueryData(trustKeys.project(projectId), trust);
    },
  });
}

/** The hosts, cloud profiles and namespaces the judge treats as live in a project. */
export function useLiveSystems(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: trustKeys.liveSystems(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['live-systems'].$get({ param: { projectId } }),
        LiveSystemsDto,
      ),
  });
}

/** Replaces a project's live systems, one change at a time; a refused list leaves the saved one. */
export function useSetLiveSystems(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: `live-systems ${projectId}` },
    mutationFn: async (liveSystems: readonly string[]) =>
      readJson(
        await client.projects[':projectId']['live-systems'].$put({
          param: { projectId },
          json: { liveSystems: [...liveSystems] },
        }),
        LiveSystemsDto,
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(trustKeys.liveSystems(projectId), saved);
    },
  });
}

/** What the builder allowed in a project from now on, oldest first. */
export function useTrustGrants(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: trustKeys.grants(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['trust-grants'].$get({ param: { projectId } }),
        z.array(TrustGrantDto),
      ),
  });
}

/** Removes one grant: 10db's judge stops reading it at the next call, auto mode at the next session. */
export function useRemoveTrustGrant(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (grantId: TrustGrantId) => {
      // The answer is 204 with no body; a refusal throws with the daemon's message.
      await readJson(
        await client.projects[':projectId']['trust-grants'][':grantId'].$delete({
          param: { projectId, grantId },
        }),
        z.unknown(),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trustKeys.grants(projectId) }),
  });
}

/** Production entries 10db read from the repo that the project does not list yet, each with where. */
export function useLiveSystemProposals(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: trustKeys.proposals(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['live-systems'].proposals.$get({
          param: { projectId },
        }),
        LiveSystemProposalsDto,
      ),
  });
}

/** The checkout's `.mcp.json` servers and where each one's approval stands; reading raises no card. */
export function useRepoMcpServers(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: trustKeys.repoMcp(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['repo-mcp-servers'].$get({ param: { projectId } }),
        RepoMcpServersDto,
      ),
  });
}

/** Approves or denies one repo server for the config the page showed; a changed config is refused. */
export function useSetRepoMcpVerdict(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: `repo-mcp ${projectId}` },
    mutationFn: async (input: SetRepoMcpVerdict & { readonly name: string }) => {
      const { name, ...json } = input;
      return readJson(
        await client.projects[':projectId']['repo-mcp-servers'][':name'].$put({
          param: { projectId, name },
          json,
        }),
        RepoMcpServersDto,
      );
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(trustKeys.repoMcp(projectId), saved);
    },
  });
}
