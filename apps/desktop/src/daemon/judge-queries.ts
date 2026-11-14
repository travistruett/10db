import {
  DecisionModelListDto,
  JudgeCallsPageDto,
  type AccountId,
  JudgeStatusDto,
  JudgeTestResultDto,
  type JudgeCallsPageQuery,
  type JudgeConfigPatch,
} from '@10db/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

/** The daemon emits no event when the judge's config or calls change, so callers invalidate these themselves. */
export const judgeKeys = {
  status: ['judge', 'status'],
  calls: ['judge', 'calls'],
  /** One page of calls; under `calls`, so invalidating `calls` refreshes every page. */
  callsPage: (query: JudgeCallsPageQuery) => ['judge', 'calls', query] as const,
  models: ['judge', 'models'],
} as const;

/** The daemon keeps OpenRouter's list for hours; an open Settings page needn't ask it again sooner than this. */
const MODELS_STALE_MS = 60 * 60 * 1000;

/** Calls made by the runner while the section is open arrive without an event, so the list polls. */
const CALLS_REFRESH_MS = 30_000;

export function useJudgeStatus() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: judgeKeys.status,
    queryFn: async () => readJson(await client.judge.$get(), JudgeStatusDto),
  });
}

/** One page of the judge's calls, newest first, as the daemon pages and filters them. */
export function useJudgeCallsPage(query: JudgeCallsPageQuery) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: judgeKeys.callsPage(query),
    queryFn: async () =>
      readJson(
        await client.judge.calls.page.$get({
          query: {
            limit: String(query.limit),
            offset: String(query.offset),
            ...(query.decision === undefined ? {} : { decision: query.decision }),
            ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
          },
        }),
        JudgeCallsPageDto,
      ),
    placeholderData: keepPreviousData,
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
