import {
  ComposePreviewDto,
  InboxItemDto,
  PersonDto,
  QuestionRouteDto,
  RoutingRuleDto,
  SlackMemberDto,
  SlackStatusDto,
  StakeholderSendDto,
  StakeholderTimersDto,
  type AskSomeoneInput,
  type InboxItemId,
  type PersonId,
  type PersonInput,
  type ProjectId,
  type RoutingRulesInput,
  type SendInput,
  type SlackTokenInput,
  type TaskId,
} from '@10db/contracts';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

const PersonList = z.array(PersonDto);
const MemberList = z.array(SlackMemberDto);
const RouteList = z.array(QuestionRouteDto);
const RuleList = z.array(RoutingRuleDto);

/** Prefix of everything about people; events invalidate by it. */
export const PEOPLE_KEY = ['people'] as const;
export const SLACK_KEY = ['slack'] as const;
export const TIMERS_KEY = ['stakeholder-timers'] as const;
export const ROUTING_RULES_KEY = ['routing-rules'] as const;
export const QUESTION_ROUTES_KEY = ['question-routes'] as const;
const INBOX_KEY = ['inbox'] as const;

export function usePeople() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: PEOPLE_KEY,
    queryFn: async () => readJson(await client.people.$get(), PersonList),
  });
}

export function useSavePerson() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      input,
    }: {
      readonly id: PersonId | null;
      readonly input: PersonInput;
    }) =>
      id === null
        ? readJson(await client.people.$post({ json: input }), PersonDto)
        : readJson(
            await client.people[':personId'].$put({ param: { personId: id }, json: input }),
            PersonDto,
          ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PEOPLE_KEY }),
  });
}

export function useRemovePerson() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: PersonId) =>
      readJson(await client.people[':personId'].$delete({ param: { personId: id } }), z.object({})),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PEOPLE_KEY }),
  });
}

export function useSlackStatus() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: SLACK_KEY,
    queryFn: async () => readJson(await client.slack.$get(), SlackStatusDto),
  });
}

/**
 * The first workspace standing for "the connection".
 * TODO(slack-workspaces): readers take every workspace from `useSlackStatus`.
 */
export interface FirstWorkspaceConnection {
  readonly state: 'off' | 'none' | 'connected' | 'refused' | 'unreachable';
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly botUserId: string | null;
  readonly checkedAt: string | null;
  readonly error: string | null;
}

function firstWorkspace(status: SlackStatusDto): FirstWorkspaceConnection {
  const empty = {
    teamId: null,
    teamName: null,
    botUserId: null,
    checkedAt: null,
    error: null,
  };
  if (status.off) return { state: 'off', ...empty };
  const first = status.workspaces.at(0);
  if (first === undefined) return { state: 'none', ...empty };
  return {
    state: first.state === 'checking' ? 'none' : first.state,
    teamId: first.teamId,
    teamName: first.teamName,
    botUserId: first.botUserId,
    checkedAt: first.checkedAt,
    error: first.error,
  };
}

/** TODO(slack-workspaces): replaced by `useSlackStatus` in the readers. */
export function useSlackConnection() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: SLACK_KEY,
    queryFn: async () => readJson(await client.slack.$get(), SlackStatusDto),
    select: firstWorkspace,
  });
}

/** Saves a token after Slack accepts it; a refusal is the mutation's error, in Slack's words. */
export function useSetSlackToken() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SlackTokenInput) =>
      readJson(await client.slack.token.$put({ json: input }), SlackStatusDto),
    // The variable is the bot token: nothing keeps it once the call settles.
    gcTime: 0,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SLACK_KEY }),
  });
}

export function useRemoveSlackWorkspace() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (teamId: string) =>
      readJson(
        await client.slack.workspaces[':teamId'].$delete({ param: { teamId } }),
        SlackStatusDto,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SLACK_KEY }),
  });
}

export function useSlackMembers(teamId: string | null, query: string, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...SLACK_KEY, 'members', teamId, query],
    enabled: enabled && teamId !== null,
    queryFn: async () =>
      readJson(
        await client.slack.members.$get({ query: { teamId: teamId ?? '', query } }),
        MemberList,
      ),
  });
}

/**
 * The workspace's member with this id, read from the whole list (the daemon keeps it), or null while
 * the workspace is not connected or the list has not loaded.
 */
export function useSlackMember(
  teamId: string | null,
  userId: string | null,
): SlackMemberDto | null {
  const status = useSlackStatus();
  const connected = status.data?.workspaces.some(
    (w) => w.teamId === teamId && w.state === 'connected',
  );
  const members = useSlackMembers(teamId, '', userId !== null && connected === true);
  return members.data?.find((m) => m.userId === userId) ?? null;
}

export function useStakeholderTimers() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: TIMERS_KEY,
    queryFn: async () => readJson(await client.stakeholders.timers.$get(), StakeholderTimersDto),
  });
}

export function useSetStakeholderTimers() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (timers: StakeholderTimersDto) =>
      readJson(await client.stakeholders.timers.$put({ json: timers }), StakeholderTimersDto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TIMERS_KEY }),
  });
}

export function useRoutingRules(projectId: ProjectId) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...ROUTING_RULES_KEY, projectId],
    queryFn: async () =>
      readJson(
        await client.projects[':projectId']['routing-rules'].$get({ param: { projectId } }),
        RuleList,
      ),
  });
}

export function useSetRoutingRules(projectId: ProjectId) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RoutingRulesInput) =>
      readJson(
        await client.projects[':projectId']['routing-rules'].$put({
          param: { projectId },
          json: input,
        }),
        RuleList,
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ROUTING_RULES_KEY }),
        queryClient.invalidateQueries({ queryKey: QUESTION_ROUTES_KEY }),
      ]),
  });
}

/** The routing rules of several projects at once, sharing the cache of `useRoutingRules`. */
export function useRoutingRulesOfProjects(projectIds: readonly ProjectId[]) {
  const { client } = useDaemon();
  return useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: [...ROUTING_RULES_KEY, projectId],
      queryFn: async () =>
        readJson(
          await client.projects[':projectId']['routing-rules'].$get({ param: { projectId } }),
          RuleList,
        ),
    })),
  });
}

/** Who a task's questions go to, by scope. */
export function useQuestionRoutes(taskId: TaskId | null) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...QUESTION_ROUTES_KEY, taskId],
    enabled: taskId !== null,
    queryFn: async () =>
      taskId === null
        ? []
        : readJson(
            await client.tasks[':taskId']['question-routes'].$get({ param: { taskId } }),
            RouteList,
          ),
  });
}

/** The message a question would be for these people, and what the outbound scan holds. */
export function useCompose(id: InboxItemId, personIds: readonly PersonId[], enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...INBOX_KEY, 'compose', id, personIds],
    enabled,
    queryFn: async () =>
      readJson(
        await client.inbox[':id'].compose.$get({
          param: { id },
          query: { personIds: personIds.join(',') },
        }),
        ComposePreviewDto,
      ),
  });
}

function useInboxMutation<V>(call: (variables: V) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: INBOX_KEY }),
        queryClient.invalidateQueries({ queryKey: ['workstreams'] }),
      ]),
  });
}

export function useSendInbox() {
  const { client } = useDaemon();
  return useInboxMutation(
    async ({ id, input }: { readonly id: InboxItemId; readonly input: SendInput }) =>
      readJson(
        await client.inbox[':id'].send.$post({ param: { id }, json: input }),
        StakeholderSendDto,
      ),
  );
}

export function useAskSomeone() {
  const { client } = useDaemon();
  return useInboxMutation(
    async ({ id, input }: { readonly id: InboxItemId; readonly input: AskSomeoneInput }) =>
      readJson(await client.inbox[':id'].ask.$post({ param: { id }, json: input }), InboxItemDto),
  );
}

export function useTakeBack() {
  const { client } = useDaemon();
  return useInboxMutation(async (id: InboxItemId) =>
    readJson(await client.inbox[':id']['take-back'].$post({ param: { id } }), InboxItemDto),
  );
}

export function useKeepWaiting() {
  const { client } = useDaemon();
  return useInboxMutation(async (id: InboxItemId) =>
    readJson(await client.inbox[':id']['keep-waiting'].$post({ param: { id } }), InboxItemDto),
  );
}
