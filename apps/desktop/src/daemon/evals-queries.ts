import {
  EvalMarkersDto,
  EvalModelsDto,
  EvalsDto,
  EvalSuiteDetailDto,
  TaskEvalCoverageDto,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { keepPreviousData, skipToken, useQuery } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

/** Query keys; a `project` event invalidates them all, since a recorded manifest is the project's. */
export const evalsKeys = {
  all: ['evals'],
  list: (projectId: ProjectId) => ['evals', projectId] as const,
  models: (projectId: ProjectId) => ['evals', projectId, 'models'] as const,
  suite: (projectId: ProjectId, key: string, run: string | null) =>
    ['evals', projectId, 'suite', key, run] as const,
} as const;

/** What 10db has found of a project's evals at its HEAD. */
export function useEvals(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: evalsKeys.list(projectId),
    queryFn: async () =>
      readJson(await client.projects[':projectId'].evals.$get({ param: { projectId } }), EvalsDto),
  });
}

/** A suite's drawer, with `run` shown whole (the newest when null). */
export function useEvalSuite(projectId: ProjectId, key: string | null, run: string | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: evalsKeys.suite(projectId, key ?? '', run),
    enabled: key !== null,
    // Picking another run keeps the drawer drawn until that run lands.
    placeholderData: keepPreviousData,
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].evals[':suiteKey'].$get({
          // Hono's client puts a param into the path as it is, and a key may hold `/` or `:`.
          param: { projectId, suiteKey: encodeURIComponent(key ?? '') },
          query: run === null ? {} : { run },
        }),
        EvalSuiteDetailDto,
      ),
  });
}

/** Every model the project's results graded, fetched once the By Model tab opens. */
export function useEvalModels(projectId: ProjectId, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: evalsKeys.models(projectId),
    enabled,
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['eval-models'].$get({ param: { projectId } }),
        EvalModelsDto,
      ),
  });
}

/** Query keys of the covered-task markers; an evidence event for any run invalidates them. */
export const evalMarkerKeys = {
  all: ['eval-markers'],
  project: (projectId: ProjectId) => ['eval-markers', projectId] as const,
  task: (taskId: TaskId) => ['eval-markers', 'task', taskId] as const,
} as const;

/** The suites each of the project's tasks touched, with where each stands against the checkout's results. */
export function useEvalMarkers(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: evalMarkerKeys.project(projectId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['eval-markers'].$get({ param: { projectId } }),
        EvalMarkersDto,
      ),
  });
}

/** One task's touched suites with their results before and after it; nothing before the task has a run. */
export function useTaskEvalCoverage(taskId: TaskId | undefined) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: taskId === undefined ? [...evalMarkerKeys.all, 'none'] : evalMarkerKeys.task(taskId),
    queryFn:
      taskId === undefined
        ? skipToken
        : async () =>
            readJson(
              await client.tasks[':taskId']['eval-coverage'].$get({ param: { taskId } }),
              TaskEvalCoverageDto,
            ),
  });
}
