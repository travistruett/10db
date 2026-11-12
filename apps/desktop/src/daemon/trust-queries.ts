import {
  ProjectTrustDto,
  TrustSettingsDto,
  type ProjectId,
  type TrustOverrides,
  type TrustSwitches,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

// Trust spec §9: what comes along into each session, app-wide and per project.

export const trustKeys = {
  app: ['trust'],
  project: (projectId: ProjectId) => ['trust', 'project', projectId],
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
