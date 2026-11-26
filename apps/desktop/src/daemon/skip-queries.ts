import { SkippedActionDto, TaskDto, type WorkstreamId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

// Trust line §5: what a run nobody watched skipped, and the questions it was answered at once.

export const skipKeys = {
  all: ['workstream-skips'],
  of: (id: WorkstreamId) => ['workstream-skips', id] as const,
} as const;

/** A run's skips and away-answered questions, oldest first. */
export function useWorkstreamSkips(id: WorkstreamId | undefined) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: id ? skipKeys.of(id) : ['workstream-skips', 'none'],
    queryFn: async () =>
      id
        ? readJson(
            await client.workstreams[':id'].skips.$get({ param: { id } }),
            z.array(SkippedActionDto),
          )
        : [],
    enabled: id !== undefined,
  });
}

/** Run These Now: a follow-up task that runs, approved, the calls the run skipped. */
export function useRunSkippedCalls() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: WorkstreamId) =>
      readJson(await client.workstreams[':id'].skips.run.$post({ param: { id } }), TaskDto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
