import { KindDto } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

export const kindKeys = { all: ['kinds'] as const };

/** The kinds a task can have, in the builder's order. */
export function useKinds() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: kindKeys.all,
    queryFn: async () => readJson(await client.kinds.$get(), z.array(KindDto)),
  });
}
