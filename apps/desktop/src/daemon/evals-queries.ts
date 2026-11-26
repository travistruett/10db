import {
  EvalLivePreviewDto,
  EvalLiveRunDto,
  EvalMarkersDto,
  EvalModelsDto,
  EvalsDto,
  EvalSuiteDetailDto,
  TaskDto,
  TaskEvalCoverageDto,
  type EvalLiveRunId,
  type NewEvalBody,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import {
  keepPreviousData,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { readJson, refuse } from './client';
import { useDaemon } from './provider';

/** Query keys; a `project` event invalidates them all, since a recorded manifest is the project's. */
export const evalsKeys = {
  all: ['evals'],
  list: (projectId: ProjectId) => ['evals', projectId] as const,
  models: (projectId: ProjectId) => ['evals', projectId, 'models'] as const,
  suite: (projectId: ProjectId, key: string, run: string | null) =>
    ['evals', projectId, 'suite', key, run] as const,
  live: (projectId: ProjectId, key: string) => ['evals', projectId, 'live', key] as const,
  liveRuns: (projectId: ProjectId, key: string | null) =>
    ['evals', projectId, 'live-runs', key] as const,
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

/** Files the task that drafts an eval; the lane that takes it writes the cases and never runs them. */
export function useNewEvalTask(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewEvalBody) =>
      readJson(
        await client.projects[':projectId'].evals.tasks.$post({
          param: { projectId },
          json: input,
        }),
        TaskDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

/** What a suite's Run would do and whether it may; read again on every project event. */
export function useEvalLivePreview(projectId: ProjectId, suiteKey: string, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: evalsKeys.live(projectId, suiteKey),
    enabled,
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].evals[':suiteKey'].live.$get({
          param: { projectId, suiteKey: encodeURIComponent(suiteKey) },
        }),
        EvalLivePreviewDto,
      ),
  });
}

/** A project's newest live runs (five), of one suite or all. */
export function useEvalLiveRuns(projectId: ProjectId, suiteKey: string | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: evalsKeys.liveRuns(projectId, suiteKey),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].evals.live.runs.$get({
          param: { projectId },
          query: suiteKey === null ? {} : { suite: suiteKey },
        }),
        z.array(EvalLiveRunDto),
      ),
  });
}

/** The click: posts the hash the window showed. A refusal throws a `DaemonRequestError` of 409 whose body names it. */
export function useStartEvalLive(projectId: ProjectId, suiteKey: string) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (previewHash: string) =>
      readJson(
        await client.projects[':projectId'].evals[':suiteKey'].live.runs.$post({
          param: { projectId, suiteKey: encodeURIComponent(suiteKey) },
          json: { previewHash },
        }),
        EvalLiveRunDto,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: evalsKeys.list(projectId) }),
  });
}

export function useStopEvalLive(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (runId: EvalLiveRunId) => {
      const res = await client.projects[':projectId'].evals.live.runs[':runId'].stop.$post({
        param: { projectId, runId },
      });
      // The type knows only the 204; the daemon's errors (404 for a run that ended) arrive too.
      const status: number = res.status;
      if (status !== 204) refuse(status, await res.json().catch(() => null));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: evalsKeys.list(projectId) }),
  });
}
