import { SelfUpdateStatusDto } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

const selfUpdateKey = ['self-update'] as const;

/** Whether 10db installs main's build by itself, and the commits involved. One setting for the app. */
export function useSelfUpdate() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: selfUpdateKey,
    queryFn: async () => readJson(await client.settings['self-update'].$get(), SelfUpdateStatusDto),
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
