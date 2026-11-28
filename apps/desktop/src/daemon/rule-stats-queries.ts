import { RuleStatsListDto, type ProjectId } from '@10db/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

/** Decisions arrive while the tab is open without an event of their own, so the counts poll. */
const RULE_STATS_REFRESH_MS = 30_000;

export const ruleStatsKeys = {
  all: ['rules', 'stats'],
  project: (project: ProjectId | null) => ['rules', 'stats', project] as const,
} as const;

/** What each rule decided, had undone and sent up in the last 30 days, in one project or in every active one. */
export function useRuleStats(project: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ruleStatsKeys.project(project),
    queryFn: async () =>
      readJson(
        await client.rules.stats.$get({ query: project === null ? {} : { project } }),
        RuleStatsListDto,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: RULE_STATS_REFRESH_MS,
    refetchOnWindowFocus: 'always',
  });
}
