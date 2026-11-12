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

/** Saves the app-wide switches; every project's effective switches and preview follow them. */
export function useSetTrust() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (switches: TrustSwitches) =>
      readJson(await client.settings.trust.$put({ json: switches }), TrustSettingsDto),
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

export function useSetProjectTrust(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (overrides: TrustOverrides) =>
      readJson(
        await client.projects[':projectId'].trust.$put({ param: { projectId }, json: overrides }),
        ProjectTrustDto,
      ),
    onSuccess: (trust) => {
      queryClient.setQueryData(trustKeys.project(projectId), trust);
    },
  });
}
