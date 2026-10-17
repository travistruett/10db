import {
  InboxItemDto,
  KeepAwakeStatus,
  ProjectDto,
  SystemCheckDto,
  TaskDto,
  WorkstreamDto,
  type InboxAnswer,
  type InboxItemId,
  type KeepAwakeMode,
  type ProjectId,
  type ProjectInput,
  type TaskId,
  type TaskInput,
  type WorkstreamId,
} from '@10db/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson, type DaemonClient } from './client';
import { useDaemon } from './provider';

/** Query keys; events invalidate by prefix (`['tasks']` covers every project's task list). */
export const queryKeys = {
  projects: ['projects'],
  tasks: (projectId: ProjectId) => ['tasks', projectId] as const,
  workstreams: (active: boolean) => ['workstreams', { active }] as const,
  inbox: ['inbox'],
  keepAwake: ['keep-awake'],
  system: ['system'],
} as const;

const ProjectList = z.array(ProjectDto);
const TaskList = z.array(TaskDto);
const WorkstreamList = z.array(WorkstreamDto);
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

/** The daemon's startup check: login-env status and the tools on the login PATH. It changes only on restart. */
export function useSystemCheck() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: queryKeys.system,
    queryFn: async () => readJson(await client.system.$get(), SystemCheckDto),
    staleTime: Infinity,
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
      readJson(await client.tasks[':taskId'].start.$post({ param: { taskId } }), WorkstreamDto),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
      ]),
  });
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

/** @public Consumed by the views built on this layer. */
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
