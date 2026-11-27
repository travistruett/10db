import {
  ProjectWatchpointsDto,
  WatchpointCoverageDto,
  WatchpointHitsDto,
  WatchpointStatsDto,
  YourWatchpoints,
  type ProjectId,
  type ProjectWatchpoints,
  type WorkstreamId,
} from '@10db/contracts';
import { z } from 'zod';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

export const watchpointKeys = {
  all: ['watchpoints'],
  yours: ['watchpoints', 'yours'],
  project: (id: ProjectId) => ['watchpoints', 'project', id] as const,
  /** Every project's last 30 days: a run's reading or a card's answer refetches them. */
  allStats: ['watchpoints', 'stats'],
  stats: (id: ProjectId) => ['watchpoints', 'stats', id] as const,
  /** Every count: a landed one refetches them all. */
  allCoverage: ['watchpoints', 'coverage'],
  /** The files each watchpoint covers: one project's, or All Projects' when no id. */
  coverage: (id: ProjectId | null) => ['watchpoints', 'coverage', id ?? 'all'] as const,
  /** Every run's reading: a new evidence row for any run refetches the open ones. */
  hits: ['watchpoint-hits'],
  hitsOf: (id: WorkstreamId) => ['watchpoint-hits', id] as const,
} as const;

/** The watchpoints that apply in every project. */
export function useYourWatchpoints() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: watchpointKeys.yours,
    queryFn: async () => readJson(await client.settings.watchpoints.$get(), YourWatchpoints),
  });
}

/** Replaces the whole list of the builder's watchpoints. */
export function useSetYourWatchpoints() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (watchpoints: YourWatchpoints) =>
      readJson(await client.settings.watchpoints.$put({ json: watchpoints }), YourWatchpoints),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: watchpointKeys.all }),
  });
}

/** What applies in the project, tagged by where each came from, and the project's own entries behind it. */
export function useProjectWatchpoints(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: watchpointKeys.project(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].watchpoints.$get({ param: { projectId } }),
        ProjectWatchpointsDto,
      ),
  });
}

/** Replaces the whole list of the project's own entries. */
export function useSetProjectWatchpoints(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (entries: ProjectWatchpoints) =>
      readJson(
        await client.projects[':projectId'].watchpoints.$put({
          param: { projectId },
          json: entries,
        }),
        ProjectWatchpointsDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: watchpointKeys.all }),
  });
}

/** A run's newest watchpoint reading with the agent's and reviewer's notes on each file. */
export function useWatchpointHits(id: WorkstreamId | undefined) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: id ? watchpointKeys.hitsOf(id) : [...watchpointKeys.hits, 'none'],
    queryFn:
      id === undefined
        ? skipToken
        : async () =>
            readJson(
              await client.workstreams[':id']['watchpoint-hits'].$get({ param: { id } }),
              WatchpointHitsDto,
            ),
  });
}

/** Each watchpoint's last 30 days in the project: the tasks it hit and the Look cards it raised. */
export function useWatchpointStats(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: watchpointKeys.stats(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].watchpoints.stats.$get({ param: { projectId } }),
        z.array(WatchpointStatsDto),
      ),
  });
}

/** A count stays fresh this long; the daemon says when one lands, so nothing polls. */
const COVERAGE_STALE_MS = 60_000;

/**
 * The files each watchpoint and starter covers in the project's checkout, or summed over the active projects when
 * `projectId` is null. A count the daemon is still making answers `counting`; its `watchpoint_coverage` event
 * refetches this when it lands.
 */
export function useWatchpointCoverage(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: watchpointKeys.coverage(projectId),
    staleTime: COVERAGE_STALE_MS,
    queryFn: async () =>
      readJson(
        projectId === null
          ? await client.settings.watchpoints.coverage.$get()
          : await client.projects[':projectId'].watchpoints.coverage.$get({ param: { projectId } }),
        WatchpointCoverageDto,
      ),
  });
}
