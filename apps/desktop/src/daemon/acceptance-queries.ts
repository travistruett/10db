import { AcceptanceFigures, type ProjectId, type RigorFiguresPeriod } from '@10db/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

export const acceptanceFiguresKeys = {
  all: ['acceptance-figures'],
  period: (projectId: ProjectId, days: RigorFiguresPeriod) =>
    ['acceptance-figures', projectId, days] as const,
} as const;

/** What acceptance did for the project in the last `days` days, and whether it is checking. */
export function useAcceptanceFigures(projectId: ProjectId | null, days: RigorFiguresPeriod) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId
      ? acceptanceFiguresKeys.period(projectId, days)
      : ['acceptance-figures', 'none'],
    queryFn: async () =>
      projectId
        ? readJson(
            await client.projects[':projectId']['acceptance-figures'].$get({
              param: { projectId },
              query: { days: String(days) },
            }),
            AcceptanceFigures,
          )
        : {
            days,
            completed: 0,
            sentBack: 0,
            sentToYou: 0,
            rows: { completed: [], sentBack: [], sentToYou: [] },
            checking: { on: true } as const,
          },
    enabled: projectId !== null,
    placeholderData: keepPreviousData,
  });
}
