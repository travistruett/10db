import {
  BatchDto,
  BoardColumnDto,
  FlowDto,
  InboxItemDto,
  KeepAwakeStatus,
  PickerProposalDto,
  ProjectDto,
  ProjectViewDto,
  RunNextResult,
  SystemCheckDto,
  TaskDto,
  TaskStartResult,
  WorkstreamChangesDto,
  WorkstreamDto,
  type BatchId,
  type BoardColumnDelete,
  type BoardColumnId,
  type BoardColumnInput,
  type BoardColumnPatch,
  type InboxAnswer,
  type InboxItemId,
  type KeepAwakeMode,
  type ProjectId,
  type ProjectInput,
  type ProjectPatch,
  type TaskId,
  type TaskInput,
  type TaskPatch,
  type WorkstreamId,
} from '@10db/contracts';
import {
  queryOptions,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { readJson, type DaemonClient } from './client';
import { useDaemon } from './provider';

/** Query keys; events invalidate by prefix (`['tasks']` covers every project's task list). */
export const queryKeys = {
  projects: ['projects'],
  tasks: (projectId: ProjectId) => ['tasks', projectId] as const,
  batches: (projectId: ProjectId) => ['batches', projectId] as const,
  boardColumns: (projectId: ProjectId) => ['board-columns', projectId] as const,
  workstreams: (active: boolean) => ['workstreams', { active }] as const,
  inbox: ['inbox'],
  workstreamChanges: (id: WorkstreamId | undefined, head: string | null) =>
    ['workstream-changes', id, head] as const,
  keepAwake: ['keep-awake'],
  system: ['system'],
  flows: ['flows'],
  candidates: (projectId: ProjectId, size: number) => ['candidates', projectId, size] as const,
} as const;

const ProjectList = z.array(ProjectViewDto);
const TaskList = z.array(TaskDto);
const BatchList = z.array(BatchDto);
const WorkstreamList = z.array(WorkstreamDto);
const BoardColumnList = z.array(BoardColumnDto);
const FlowList = z.array(FlowDto);
const InboxList = z.array(InboxItemDto);

/** Open cards; shared by the Inbox view, the nav badge and notifications. */
export function inboxQueryOptions(client: DaemonClient) {
  return queryOptions({
    queryKey: queryKeys.inbox,
    queryFn: async () => readJson(await client.inbox.$get({ query: { state: 'OPEN' } }), InboxList),
  });
}

export function useProjects() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: async () => readJson(await client.projects.$get(), ProjectList),
  });
}

export function useTasks(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId ? queryKeys.tasks(projectId) : ['tasks', 'none'],
    queryFn: async () =>
      projectId
        ? readJson(
            await client.projects[':projectId'].tasks.$get({ param: { projectId } }),
            TaskList,
          )
        : [],
    enabled: projectId !== null,
  });
}

/** Every batch of the project, newest first; the board lists them and finds each shipped pull request. */
export function useBatches(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId ? queryKeys.batches(projectId) : ['batches', 'none'],
    queryFn: async () =>
      projectId
        ? readJson(
            await client.projects[':projectId'].batches.$get({ param: { projectId } }),
            BatchList,
          )
        : [],
    enabled: projectId !== null,
  });
}

export function useBoardColumns(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId ? queryKeys.boardColumns(projectId) : ['board-columns', 'none'],
    queryFn: async () =>
      projectId
        ? readJson(
            await client.projects[':projectId']['board-columns'].$get({ param: { projectId } }),
            BoardColumnList,
          )
        : [],
    enabled: projectId !== null,
  });
}

export function useWorkstreams(filter: { readonly active: boolean }) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.workstreams(filter.active),
    queryFn: async () =>
      readJson(
        await client.workstreams.$get({ query: { active: String(filter.active) } }),
        WorkstreamList,
      ),
  });
}

/**
 * What a workstream changed since it started: the diff a finished, ungated task is checked by. It is
 * keyed by the head the card names, so a new round never shows the previous round's diff.
 */
export function useWorkstreamChanges(id: WorkstreamId | undefined, head: string | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.workstreamChanges(id, head),
    queryFn:
      id === undefined
        ? skipToken
        : async () =>
            readJson(
              await client.workstreams[':id'].changes.$get({ param: { id } }),
              WorkstreamChangesDto,
            ),
  });
}

export function useInbox() {
  const { client } = useDaemon();
  return useQuery(inboxQueryOptions(client));
}

export function useKeepAwake() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.keepAwake,
    queryFn: async () => readJson(await client.settings['keep-awake'].$get(), KeepAwakeStatus),
  });
}

/** The daemon's startup check: login-env status and the tools the daemon runs. It changes only on restart. */
export function useSystemCheck() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.system,
    queryFn: async () => readJson(await client.system.$get({ query: {} }), SystemCheckDto),
    staleTime: Infinity,
  });
}

/** Probes the tools and gh's login again (`GET /system?recheck=1`) and replaces the system query's data with the answer. */
export function useRecheckSystem() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      readJson(await client.system.$get({ query: { recheck: '1' } }), SystemCheckDto),
    onSuccess: (check) => {
      queryClient.setQueryData(queryKeys.system, check);
    },
  });
}

export function useCreateProject() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProjectInput) =>
      readJson(await client.projects.$post({ json: input }), ProjectDto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

export function useCreateTask(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TaskInput) =>
      readJson(
        await client.projects[':projectId'].tasks.$post({ param: { projectId }, json: input }),
        TaskDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

export function useStartTask() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: TaskId) =>
      readJson(await client.tasks[':taskId'].start.$post({ param: { taskId } }), TaskStartResult),
    // A pull-request start also changes the project's batch, and a refused one raises an Inbox card.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.inbox }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
        queryClient.invalidateQueries({ queryKey: ['batches'] }),
      ]),
  });
}

/** Puts a queued task first in line for the next free lane. */
export function useRunNext() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: TaskId) =>
      readJson(
        await client.tasks[':taskId']['run-next'].$post({ param: { taskId } }),
        RunNextResult,
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
      ]),
  });
}

/** Closes a task whose run failed; it leaves the Board, its run stays in Factory. */
export function useCloseTask() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: TaskId) =>
      readJson(await client.tasks[':taskId'].close.$post({ param: { taskId } }), TaskDto),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['candidates'] }),
      ]),
  });
}

export function useShipBatch() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (batchId: BatchId) =>
      readJson(await client.batches[':batchId'].ship.$post({ param: { batchId } }), BatchDto),
    onSuccess: () => invalidateBatchViews(queryClient),
  });
}

export function useAbandonBatch() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (batchId: BatchId) =>
      readJson(await client.batches[':batchId'].abandon.$post({ param: { batchId } }), BatchDto),
    onSuccess: () => invalidateBatchViews(queryClient),
  });
}

/** A batch action changes the project's strip, its workstreams and its tasks' columns. */
function invalidateBatchViews(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    queryClient.invalidateQueries({ queryKey: ['batches'] }),
    queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
    queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  ]);
}

export function useCancelWorkstream() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: WorkstreamId) =>
      readJson(await client.workstreams[':id'].cancel.$post({ param: { id } }), WorkstreamDto),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      ]),
  });
}

export function useRetryWorkstream() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: WorkstreamId) =>
      readJson(await client.workstreams[':id'].retry.$post({ param: { id } }), WorkstreamDto),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      ]),
  });
}

export function useAnswerInbox() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      answer,
    }: {
      readonly id: InboxItemId;
      readonly answer: InboxAnswer;
    }) =>
      readJson(
        await client.inbox[':id'].answer.$post({ param: { id }, json: answer }),
        InboxItemDto,
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.inbox }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
      ]),
  });
}

export function useSetKeepAwake() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mode: KeepAwakeMode) =>
      readJson(await client.settings['keep-awake'].$put({ json: { mode } }), KeepAwakeStatus),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.keepAwake, status);
    },
  });
}

export function useCreateBoardColumn(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: BoardColumnInput) =>
      readJson(
        await client.projects[':projectId']['board-columns'].$post({
          param: { projectId },
          json: input,
        }),
        BoardColumnDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['board-columns'] }),
  });
}

export function usePatchBoardColumn() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      readonly id: BoardColumnId;
      readonly patch: BoardColumnPatch;
    }) =>
      readJson(
        await client['board-columns'][':columnId'].$patch({ param: { columnId: id }, json: patch }),
        BoardColumnList,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['board-columns'] }),
  });
}

export function useDeleteBoardColumn() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      moveTasksTo,
    }: {
      readonly id: BoardColumnId;
      readonly moveTasksTo: BoardColumnDelete['moveTasksTo'];
    }) =>
      readJson(
        await client['board-columns'][':columnId'].delete.$post({
          param: { columnId: id },
          json: { moveTasksTo },
        }),
        BoardColumnList,
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['board-columns'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      ]),
  });
}

export function useFlows() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.flows,
    queryFn: async () => readJson(await client.flows.$get(), FlowList),
  });
}

export function usePatchProject(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ProjectPatch) =>
      readJson(
        await client.projects[':projectId'].$patch({ param: { projectId }, json: patch }),
        ProjectDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

/** The picker's proposal for the batch sheet: the project's Ready tasks, each with its step plan. */
export function useCandidates(projectId: ProjectId, size: number, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.candidates(projectId, size),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].candidates.$get({
          param: { projectId },
          query: { size: String(size) },
        }),
        PickerProposalDto,
      ),
    enabled,
  });
}

export function usePatchTask() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, patch }: { readonly taskId: TaskId; readonly patch: TaskPatch }) =>
      readJson(await client.tasks[':taskId'].$patch({ param: { taskId }, json: patch }), TaskDto),
    // A new flow or risk tag re-plans the task's steps.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['candidates'] }),
      ]),
  });
}
