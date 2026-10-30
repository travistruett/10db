import { FoundHostDto, NetworkHostDto, type ProjectId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

const NetworkHostList = z.array(NetworkHostDto);
const FoundHostList = z.array(FoundHostDto);

/** Prefix of every project's host list; events invalidate by it. */
export const NETWORK_HOSTS_KEY = ['network-hosts'] as const;

/** The hosts the project's tasks and checks may reach. */
export function useNetworkHosts(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...NETWORK_HOSTS_KEY, projectId],
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['network-hosts'].$get({ param: { projectId } }),
        NetworkHostList,
      ),
  });
}

/** Allows a host; a refusal arrives as the mutation's error, in the daemon's words. */
export function useAllowNetworkHost(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (host: string) =>
      readJson(
        await client.projects[':projectId']['network-hosts'].$post({
          param: { projectId },
          json: { host },
        }),
        NetworkHostDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NETWORK_HOSTS_KEY }),
  });
}

/**
 * Reads the project's package files again; answers the hosts they name that are not allowed, each
 * with its file. It allows nothing: the builder allows each one by name.
 */
export function useScanNetworkHosts(projectId: ProjectId) {
  const { client } = useDaemon();
  return useMutation({
    mutationFn: async () =>
      readJson(
        await client.projects[':projectId']['network-hosts'].scan.$post({ param: { projectId } }),
        FoundHostList,
      ),
  });
}

export function useRemoveNetworkHost(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (host: string) =>
      readJson(
        await client.projects[':projectId']['network-hosts'][':host'].$delete({
          param: { projectId, host },
        }),
        NetworkHostDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NETWORK_HOSTS_KEY }),
  });
}
