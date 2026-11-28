import {
  ChangesScope,
  fromTaskRow,
  BatchDto,
  AgentSkillStatus,
  BoardColumnDto,
  InboxItemDto,
  InboxPageDto,
  KeepAwakeStatus,
  LanePermissionsDto,
  PickerProposalDto,
  ProjectDto,
  ProjectViewDto,
  RunNextResult,
  AgentCopyState,
  SystemCheckDto,
  TaskDto,
  TaskRowDto,
  TaskStartResult,
  WorkstreamChangesDto,
  WorkstreamDto,
  type BatchId,
  type BoardColumnDelete,
  type BoardColumnId,
  type BoardColumnInput,
  type BoardColumnPatch,
  type GoalId,
  type InboxAnswer,
  type InboxItemId,
  type InboxPageQuery,
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
  keepPreviousData,
  queryOptions,
  skipToken,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { useRenderMode } from '../screens/render-context';
import { readJson, type DaemonClient } from './client';
import { useDaemon } from './provider';

/** Query keys; events invalidate by prefix (`['tasks']` covers every project's task list). */
export const queryKeys = {
  projects: ['projects'],
  /** The Workbench setup read for a project (`useWorkbenchSetup`). */
  workbenchSetup: (projectId: ProjectId) => ['workbench-setup', projectId] as const,
  tasks: (projectId: ProjectId) => ['tasks', projectId] as const,
  batches: (projectId: ProjectId) => ['batches', projectId] as const,
  boardColumns: (projectId: ProjectId) => ['board-columns', projectId] as const,
  workstreams: (active: boolean) => ['workstreams', { active }] as const,
  inbox: ['inbox'],
  // Under `inbox`, so the events that refresh the open cards refresh the pages too.
  inboxPage: (query: InboxPageRead) => ['inbox', 'page', query] as const,
  workstreamChanges: (id: WorkstreamId | undefined, head: string | null, scope: ChangesScope) =>
    ['workstream-changes', id, head, scope] as const,
  keepAwake: ['keep-awake'],
  agentSkill: ['agent-skill'],
  lanePermissions: ['lane-permissions'],
  system: ['system'],
  candidates: (projectId: ProjectId, size: number, goalId: GoalId | null) =>
    ['candidates', projectId, size, goalId] as const,
} as const;

const ProjectList = z.array(ProjectViewDto);
const TaskRowList = z.array(TaskRowDto);
const BatchList = z.array(BatchDto);
export const WorkstreamList = z.array(WorkstreamDto);
const BoardColumnList = z.array(BoardColumnDto);
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

/** The project's task list as its rows say it; a task's description and criteria are in `useTask`. */
async function readTaskList(client: DaemonClient, projectId: ProjectId): Promise<TaskDto[]> {
  const rows = await readJson(
    await client.projects[':projectId'].tasks.$get({ param: { projectId } }),
    TaskRowList,
  );
  return rows.map((row) => fromTaskRow(projectId, row));
}

/**
 * The project's tasks. Each carries what the Board and the lists show; its `description`, `acceptanceCriteria`
 * and the reasons for its rigor are empty here, and `useTask` reads them.
 */
export function useTasks(projectId: ProjectId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: projectId ? queryKeys.tasks(projectId) : ['tasks', 'none'],
    queryFn: async () => (projectId ? readTaskList(client, projectId) : []),
    enabled: projectId !== null,
  });
}

/**
 * One task whole, as its drawer shows it: the description, the criteria and why it has its rigor. Under
 * `['tasks']`, so whatever refreshes the lists refreshes it.
 */
export function useTask(taskId: TaskId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: ['tasks', 'task', taskId],
    queryFn: async () =>
      taskId
        ? readJson(await client.tasks[':taskId'].$get({ param: { taskId } }), TaskDto)
        : undefined,
    enabled: taskId !== null,
  });
}

/**
 * The tasks of several projects at once, in the order given. A link names a task by ID alone, so
 * finding its project means asking each one; the entries share the cache of `useTasks`.
 */
export function useTasksOfProjects(projectIds: readonly ProjectId[]) {
  const { client } = useDaemon();
  return useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: queryKeys.tasks(projectId),
      queryFn: () => readTaskList(client, projectId),
    })),
  });
}

/** The batches of several projects at once, in the order given; the entries share the cache of `useBatches`. */
export function useBatchesOfProjects(projectIds: readonly ProjectId[]) {
  const { client } = useDaemon();
  return useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: queryKeys.batches(projectId),
      queryFn: async () =>
        readJson(
          await client.projects[':projectId'].batches.$get({ param: { projectId } }),
          BatchList,
        ),
    })),
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

/** The read of what a workstream changed, shared by the view and a prefetch of it. */
export function workstreamChangesQuery(
  client: DaemonClient,
  id: WorkstreamId | undefined,
  head: string | null,
  scope: ChangesScope,
) {
  return queryOptions({
    queryKey: queryKeys.workstreamChanges(id, head, scope),
    queryFn:
      id === undefined
        ? skipToken
        : async () =>
            readJson(
              await client.workstreams[':id'].changes.$get({ param: { id }, query: { scope } }),
              WorkstreamChangesDto,
            ),
  });
}

/**
 * What a workstream changed since it started: the diff a finished, ungated task is checked by. It is
 * keyed by the head the card names, so a new round never shows the previous round's diff.
 *
 * A view that follows a running task (`follow`) keys it by the run's last change instead, which moves
 * often: while the newer read is on its way, the same workstream and scope's last diff stays on screen.
 */
export function useWorkstreamChanges(
  id: WorkstreamId | undefined,
  head: string | null,
  scope: ChangesScope = ChangesScope.All,
  follow = false,
) {
  const { client } = useDaemon();
  return useQuery({
    ...workstreamChangesQuery(client, id, head, scope),
    placeholderData: (previous, previousQuery) =>
      follow && previousQuery?.queryKey[1] === id && previousQuery?.queryKey[3] === scope
        ? previous
        : undefined,
  });
}

export function useInbox() {
  const { client } = useDaemon();
  // The Inbox is every project's; a frame drawn for a session shows only that session's project (§5.5).
  const projectId = useRenderMode()?.projectId;
  return useQuery({
    ...inboxQueryOptions(client),
    select: (items) =>
      projectId === undefined ? items : items.filter((item) => item.projectId === projectId),
  });
}

/** What `useInboxPage` sends: the fields the query key holds are the fields the request carries. */
export type InboxPageRead = Omit<InboxPageQuery, 'q' | 'since' | 'after' | 'card'>;

/**
 * One page of open, waiting or resolved cards, filtered, sorted and counted by the daemon. A frame drawn
 * for a session asks for that session's project only (§5.5), whatever project the query names.
 */
export function useInboxPage(query: InboxPageRead) {
  const { client } = useDaemon();
  const renderProject = useRenderMode()?.projectId;
  const asked: InboxPageRead =
    renderProject === undefined ? query : { ...query, project: renderProject };
  return useQuery({
    queryKey: queryKeys.inboxPage(asked),
    queryFn: async () =>
      readJson(
        await client.inbox.page.$get({
          query: {
            state: asked.state,
            ...(asked.page === undefined ? {} : { page: asked.page }),
            pageSize: String(asked.pageSize),
            ...(asked.project === undefined ? {} : { project: asked.project }),
            ...(asked.kind === undefined ? {} : { kind: asked.kind }),
            ...(asked.outcome === undefined ? {} : { outcome: asked.outcome }),
            ...(asked.person === undefined ? {} : { person: asked.person }),
            ...(asked.sort === undefined ? {} : { sort: asked.sort }),
            ...(asked.dir === undefined ? {} : { dir: asked.dir }),
          },
        }),
        InboxPageDto,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useKeepAwake() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.keepAwake,
    queryFn: async () => readJson(await client.settings['keep-awake'].$get(), KeepAwakeStatus),
  });
}

export function useAgentSkill() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.agentSkill,
    queryFn: async () => readJson(await client.settings['agent-skill'].$get(), AgentSkillStatus),
  });
}

/** How often the pinned agent copies are asked about: quickly while one is being downloaded, rarely after. */
const AGENT_FETCHING_POLL_MS = 3_000;
const AGENT_RELEASE_POLL_MS = 10 * 60_000;

/**
 * The daemon's startup check: login-env status and the tools the daemon runs. The pinned Claude Code and
 * Codex are read again, since one may be fetching and a newer release can come out while the app is open.
 * A screen's frame never asks: its token may not read `/system`, and the refusal would fail the screen.
 */
export function useSystemCheck() {
  const { client } = useDaemon();
  const frame = useRenderMode() !== null;
  return useQuery({
    queryKey: queryKeys.system,
    enabled: !frame,
    queryFn: async () => readJson(await client.system.$get({ query: {} }), SystemCheckDto),
    staleTime: Infinity,
    refetchInterval: (query) =>
      query.state.data?.agents?.some((agent) => agent.state === AgentCopyState.Fetching)
        ? AGENT_FETCHING_POLL_MS
        : AGENT_RELEASE_POLL_MS,
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

/**
 * Starts a task whose latest run failed in an open batch over from the base branch, where Start
 * would continue the run in that batch.
 */
export function useStartTaskOver() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: TaskId) =>
      readJson(
        await client.tasks[':taskId'].start.$post(
          { param: { taskId } },
          // `init.headers` would replace the client's, token included, so only the body is set; the
          // daemon reads a start's body as text.
          { init: { body: JSON.stringify({ fresh: true }) } },
        ),
        TaskStartResult,
      ),
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

/** A hold or a removal changes the task's run, its column and, for a removed run, its batch. */
function invalidateTaskViews(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    queryClient.invalidateQueries({ queryKey: ['batches'] }),
  ]);
}

/** Sets a started task that has not run aside (`POST /tasks/:taskId/hold`): its run leaves the queue and keeps its worktree. */
export function useHoldTask() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: TaskId) =>
      readJson(await client.tasks[':taskId'].hold.$post({ param: { taskId } }), WorkstreamDto),
    onSuccess: () => invalidateTaskViews(queryClient),
  });
}

/** Removes a task that has not run (`POST /tasks/:taskId/remove`); a held one takes its worktree and branch with it. */
export function useRemoveTask() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: TaskId) =>
      readJson(await client.tasks[':taskId'].remove.$post({ param: { taskId } }), TaskDto),
    onSuccess: () => invalidateTaskViews(queryClient),
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

/** Opens a task again after its pull request closed without merging; it returns to Ready or Backlog. */
export function useReopenTask() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: TaskId) =>
      readJson(await client.tasks[':taskId'].reopen.$post({ param: { taskId } }), TaskDto),
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
    mutationFn: async ({ id, note }: { readonly id: WorkstreamId; readonly note?: string }) =>
      readJson(
        await client.workstreams[':id'].retry.$post({
          param: { id },
          json: note ? { note } : {},
        }),
        WorkstreamDto,
      ),
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

export function useLanePermissions() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.lanePermissions,
    queryFn: async () =>
      readJson(await client.settings['lane-permissions'].$get(), LanePermissionsDto),
  });
}

export function useSetLanePermissions() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (autoMode: boolean) =>
      readJson(
        await client.settings['lane-permissions'].$put({ json: { autoMode } }),
        LanePermissionsDto,
      ),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.lanePermissions, status);
    },
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

export function useSetAgentSkill() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) =>
      readJson(await client.settings['agent-skill'].$put({ json: { enabled } }), AgentSkillStatus),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.agentSkill, status);
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

export function usePatchProject(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ProjectPatch) =>
      readJson(
        await client.projects[':projectId'].$patch({ param: { projectId }, json: patch }),
        ProjectDto,
      ),
    // A saved project makes the setup read of it stale: an Apply must not send an old proposal over it.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
        // Marked stale, read again only when the setup is next asked for.
        queryClient.invalidateQueries({
          queryKey: queryKeys.workbenchSetup(projectId),
          refetchType: 'none',
        }),
      ]),
  });
}

/**
 * The picker's proposal for the batch sheet: the project's Ready tasks, each with its step plan.
 * With a `goalId` the pool is that goal's tasks alone.
 */
export function useCandidates(
  projectId: ProjectId,
  size: number,
  enabled: boolean,
  goalId: GoalId | null = null,
) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.candidates(projectId, size, goalId),
    queryFn: async () =>
      readJson(
        await client.projects[':projectId'].candidates.$get({
          param: { projectId },
          query: { size: String(size), ...(goalId ? { goalId } : {}) },
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
    // A new rigor or kind re-plans the task's steps.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['candidates'] }),
      ]),
  });
}
