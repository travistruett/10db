import {
  DecisionModelListDto,
  JudgeCallDto,
  type AccountId,
  JudgeStatusDto,
  JudgeTestResultDto,
  type JudgeConfigPatch,
} from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

/** The daemon emits no event when the judge's config or calls change, so callers invalidate these themselves. */
export const judgeKeys = {
  status: ['judge', 'status'],
  calls: ['judge', 'calls'],
  models: ['judge', 'models'],
} as const;

/** The daemon keeps OpenRouter's list for hours; an open Settings page needn't ask it again sooner than this. */
const MODELS_STALE_MS = 60 * 60 * 1000;

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

/** OpenRouter's decision models, through the daemon; only asked for when `enabled` (a key is set). */
export function useDecisionModels(enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: judgeKeys.models,
    queryFn: async () => readJson(await client.judge.models.$get(), DecisionModelListDto),
    enabled,
    staleTime: MODELS_STALE_MS,
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

/** One tiny call on the review decision's model with the account's own key; a failed test is an answer, not an error. */
export function useTestAccount(id: AccountId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      readJson(
        await client.accounts[':accountId'].test.$post({ param: { accountId: id } }),
        JudgeTestResultDto,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: judgeKeys.calls }),
  });
}
