import { SelfUpdateStatusDto } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

const selfUpdateKey = ['self-update'] as const;

/** How often an update that waits or drains is looked at again: no event says when it starts or ends. */
const UPDATE_REFRESH_MS = 15_000;

/**
 * Whether 10db installs main's build by itself, the commits involved, and whether an update waits or
 * the factory drains for it. One setting for the app.
 */
export function useSelfUpdate() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: selfUpdateKey,
    queryFn: async () => readJson(await client.settings['self-update'].$get(), SelfUpdateStatusDto),
    // While an update is available its wait and drain change with no event, so they are looked at.
    refetchInterval: (query) =>
      query.state.data?.availableCommit != null && query.state.data.enabled
        ? UPDATE_REFRESH_MS
        : false,
  });
}

/** Turns it on or off; null goes back to the default, which is on. */
export function useSetSelfUpdate() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean | null) =>
      readJson(
        await client.settings['self-update'].$put({ json: { enabled } }),
        SelfUpdateStatusDto,
      ),
    onSuccess: (status) => {
      queryClient.setQueryData(selfUpdateKey, status);
    },
  });
}

/** Sets the minutes a waiting update waits before lanes pause for it; null is the default. */
export function useSetSelfUpdateWait() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (minutes: number | null) =>
      readJson(
        await client.settings['self-update'].wait.$put({ json: { minutes } }),
        SelfUpdateStatusDto,
      ),
    onSuccess: (status) => {
      queryClient.setQueryData(selfUpdateKey, status);
    },
  });
}

/** Install Now: lanes pause at once, and the app installs when the running steps are done. */
export function useInstallNow() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      readJson(await client.settings['self-update']['install-now'].$post(), SelfUpdateStatusDto),
    onSuccess: (status) => {
      queryClient.setQueryData(selfUpdateKey, status);
    },
  });
}
