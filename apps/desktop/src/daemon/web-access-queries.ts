import { FoundHostDto, WebHostDto, WebSearchDto, type ProjectId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

const WebHostList = z.array(WebHostDto);
const FoundHostList = z.array(FoundHostDto);

/** Prefix of every project's read list; events invalidate by it. */
export const WEB_HOSTS_KEY = ['web-hosts'] as const;
/** Prefix of every project's web search switch; events invalidate by it. */
export const WEB_SEARCH_KEY = ['web-search'] as const;

/** The hosts whose pages the project's lanes read with no card. */
export function useWebHosts(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...WEB_HOSTS_KEY, projectId],
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['web-hosts'].$get({ param: { projectId } }),
        WebHostList,
      ),
  });
}

/** Adds a host; a refusal arrives as the mutation's error, in the daemon's words. */
export function useAddWebHost(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (host: string) =>
      readJson(
        await client.projects[':projectId']['web-hosts'].$post({
          param: { projectId },
          json: { host },
        }),
        WebHostDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WEB_HOSTS_KEY }),
  });
}

export function useRemoveWebHost(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (host: string) =>
      readJson(
        await client.projects[':projectId']['web-hosts'][':host'].$delete({
          param: { projectId, host },
        }),
        WebHostDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WEB_HOSTS_KEY }),
  });
}

/**
 * Reads the project's manifests again; answers the documentation hosts that are not listed, each with
 * its file. It adds nothing: the builder adds each one by name.
 */
export function useScanWebHosts(projectId: ProjectId) {
  const { client } = useDaemon();
  return useMutation({
    mutationFn: async () =>
      readJson(
        await client.projects[':projectId']['web-hosts'].scan.$post({ param: { projectId } }),
        FoundHostList,
      ),
  });
}

export function useWebSearch(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...WEB_SEARCH_KEY, projectId],
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['web-search'].$get({ param: { projectId } }),
        WebSearchDto,
      ),
  });
}

export function useSetWebSearch(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) =>
      readJson(
        await client.projects[':projectId']['web-search'].$put({
          param: { projectId },
          json: { enabled },
        }),
        WebSearchDto,
      ),
    onSuccess: (status) => {
      queryClient.setQueryData([...WEB_SEARCH_KEY, projectId], status);
    },
  });
}
