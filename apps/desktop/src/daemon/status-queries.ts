import { StatusDto } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

export const statusKeys = { all: ['status'] as const };

/** The holds the daemon shows now; the daemon's `status.changed` event refetches it, so it does no polling. */
export function useStatus() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: statusKeys.all,
    queryFn: async () => readJson(await client.status.$get(), StatusDto),
  });
}
