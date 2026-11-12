import {
  ComposePreviewDto,
  InboxItemDto,
  PersonDto,
  QuestionRouteDto,
  RoutingRuleDto,
  SlackConnectionDto,
  SlackMemberDto,
  StakeholderSendDto,
  StakeholderTimersDto,
  type AskSomeoneInput,
  type InboxItemId,
  type PersonId,
  type PersonInput,
  type ProjectId,
  type RoutingRulesInput,
  type SendInput,
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

export function useSlackConnection() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: SLACK_KEY,
    queryFn: async () => readJson(await client.slack.$get(), SlackConnectionDto),
  });
}

/** Saves a token after Slack accepts it; a refusal is the mutation's error, in Slack's words. */
export function useSetSlackToken() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) =>
      readJson(await client.slack.token.$put({ json: { token } }), SlackConnectionDto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SLACK_KEY }),
  });
}

export function useRemoveSlackToken() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => readJson(await client.slack.token.$delete(), SlackConnectionDto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SLACK_KEY }),
  });
}

export function useSlackMembers(query: string, enabled: boolean) {
  const { client } = useDaemon();
  return useQuery({
    queryKey: [...SLACK_KEY, 'members', query],
    enabled,
    queryFn: async () =>
      readJson(await client.slack.members.$get({ query: { query } }), MemberList),
  });
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
