import {
  JudgeCallDto,
  JudgeStatusDto,
  JudgeTestResultDto,
  type JudgeConfigPatch,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

/** The daemon emits no event when the judge's config, key or calls change, so callers invalidate these themselves. */
export const judgeKeys = {
  status: ['judge', 'status'],
  calls: ['judge', 'calls'],
} as const;

const JudgeCallList = z.array(JudgeCallDto);

/** How many calls the section lists. */
const RECENT_CALLS = 20;

/** Calls made by the runner while the section is open arrive without an event, so the list polls. */
const CALLS_REFRESH_MS = 30_000;

export function useJudgeStatus() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: judgeKeys.status,
    queryFn: async () => readJson(await client.judge.$get(), JudgeStatusDto),
  });
}

export function useJudgeCalls() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: judgeKeys.calls,
    queryFn: async () =>
      readJson(
        await client.judge.calls.$get({ query: { limit: String(RECENT_CALLS) } }),
        JudgeCallList,
      ),
    refetchInterval: CALLS_REFRESH_MS,
    refetchOnWindowFocus: 'always',
  });
}

export function usePatchJudge() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: JudgeConfigPatch) =>
      readJson(await client.judge.$patch({ json: patch }), JudgeStatusDto),
    onSuccess: (status) => {
      queryClient.setQueryData(judgeKeys.status, status);
      return queryClient.invalidateQueries({ queryKey: judgeKeys.status });
    },
  });
}

/** One tiny call on the review decision's model; a failed test is an answer, not an error. */
export function useTestJudge() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => readJson(await client.judge.test.$post(), JudgeTestResultDto),
    onSettled: () => queryClient.invalidateQueries({ queryKey: judgeKeys.calls }),
  });
}
