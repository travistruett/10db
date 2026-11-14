import { RigorFiguresDto, type ProjectId, type RigorFiguresPeriod } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

export const rigorFiguresKeys = {
  all: ['rigor-figures'],
  period: (projectId: ProjectId, days: RigorFiguresPeriod) =>
    ['rigor-figures', projectId, days] as const,
} as const;

/** What the project's tasks done in the last `days` days took, by rigor; runs and cards finishing move it. */
export function useRigorFigures(projectId: ProjectId | null, days: RigorFiguresPeriod) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId ? rigorFiguresKeys.period(projectId, days) : ['rigor-figures', 'none'],
    queryFn: async () => {
      if (!projectId) throw new Error('No project chosen');
      return readJson(
        await client.projects[':projectId']['rigor-figures'].$get({
          param: { projectId },
          query: { days: String(days) },
        }),
        RigorFiguresDto,
      );
    },
    enabled: projectId !== null,
  });
}
