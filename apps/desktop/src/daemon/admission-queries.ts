import { AdmissionDto } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

/** How often the holds are looked at again: the load and free disk change with no event. */
const ADMISSION_REFRESH_MS = 30_000;

/** What holds new lanes and gates on this Mac now, one line each. */
export function useAdmission() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ['admission'] as const,
    queryFn: async () => readJson(await client.admission.$get(), AdmissionDto),
    refetchInterval: ADMISSION_REFRESH_MS,
  });
}
