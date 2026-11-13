import { BenchmarkStatusDto } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

export const benchmarkKeys = {
  status: ['benchmarks', 'status'],
} as const;

/** While a sync runs its outcome is the one before it, so the status is read again until it ends. */
const SYNCING_REFRESH_MS = 1_500;

export function useBenchmarkStatus() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: benchmarkKeys.status,
    queryFn: async () => readJson(await client.benchmarks.status.$get(), BenchmarkStatusDto),
    refetchInterval: (query) => (query.state.data?.syncing === true ? SYNCING_REFRESH_MS : false),
  });
}

/** Asks for a sync now; the answer is the status after it. */
export function useSyncBenchmarks() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => readJson(await client.benchmarks.sync.$post(), BenchmarkStatusDto),
    onSuccess: (status) => {
      queryClient.setQueryData(benchmarkKeys.status, status);
    },
  });
}
