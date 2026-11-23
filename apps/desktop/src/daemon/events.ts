import {
  AccountLoginEndedData,
  ConversationDeltaFrame,
  DaemonEvent,
  EventsHead,
  EventType,
  TaskId,
  GithubLoginEndedData,
} from '@10db/contracts';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { readJson } from './client';
import type { DaemonConnection } from './connection';
import { useDaemon } from './provider';
import { accountKeys, accountLoginKey } from './account-queries';
import { activityKeys } from './activity-queries';
import { applyInboxEvent } from './inbox-live';
import { chatKeys } from './chat-queries';
import { chatWorkKeys } from './chat-work-queries';
import { taskSessionKeys } from './task-session-queries';
import { conversationKeys, liveKeys, writeLiveFrame } from './conversation-queries';
import { githubKeys } from './github-queries';
import { goalKeys } from './goal-queries';
import { cardTypesKeys } from './card-types-queries';
import { humanTouchKeys } from './human-touch-queries';
import { rigorFiguresKeys } from './rigor-figures-queries';
import { HAZARD_ASSESSMENT_KEY } from './hazard-queries';
import { KINDS_KEY } from './kind-queries';
import { modelKeys } from './model-queries';
import { NETWORK_HOSTS_KEY } from './network-host-queries';
import { PERSONAS_KEY } from './persona-queries';
import { playbookKeys } from './playbook-queries';
import {
  PEOPLE_KEY,
  QUESTION_ROUTES_KEY,
  ROUTING_RULES_KEY,
  SLACK_KEY,
  TIMERS_KEY,
} from './people';
import { passKeys, writePassActivity } from './pass-queries';
import { folderKeys } from './project-folder-queries';
import { queryKeys } from './queries';
import { shapeKeys } from './shape-queries';
import { linearPostKeys } from './linear-queries';
import { designCheckKeys, screenKeys } from './screen-queries';
import { skipKeys } from './skip-queries';
import { statusKeys } from './status-queries';
import {
  FIGMA_SIGN_INS_KEY,
  LINEAR_SIGN_INS_KEY,
  PROJECT_INTEGRATIONS_KEY,
} from './sign-in-queries';
import { trustKeys } from './trust-queries';

export const STREAM_RETRY_BASE_MS = 500;
export const STREAM_RETRY_MAX_MS = 10_000;
/** How long the head fetch may take before the stream retries. */
const HEAD_TIMEOUT_MS = 2_000;

/** A goal's status, progress and rows are read from its tasks' runs and cards, so they follow these. */
const WORK: readonly QueryKey[] = [['workstreams'], ['tasks'], goalKeys.all];
/** The batch sheet's proposal: its candidates, claims and step plans follow all of these. */
const CANDIDATES: QueryKey = ['candidates'];

/** The Knowledge view's lists, its proposals and the provenance drawer. */
const KNOWLEDGE: readonly QueryKey[] = [['knowledge'], ['proposals'], ['provenance']];

/** What to refetch when an event about an entity type arrives. */
export const INVALIDATIONS: Readonly<Record<string, readonly QueryKey[]>> = {
  // 10db adds to a project's hazards by itself, so the page that lists the additions follows the project.
  // Your folder's holders, a chat's wait among them, change with a hold event, which is the project's.
  project: [
    queryKeys.projects,
    CANDIDATES,
    HAZARD_ASSESSMENT_KEY,
    folderKeys.all,
    chatWorkKeys.all,
  ],
  // A run's skip is recorded under its task's event; a task becoming done, or changing rigor, moves the rigor
  // figures.
  // Accept and Start's counts follow lanes freeing up.
  task: [
    ['tasks'],
    goalKeys.all,
    CANDIDATES,
    skipKeys.all,
    rigorFiguresKeys.all,
    shapeKeys.startCountsAll,
  ],
  // A goal's strip counts its tasks and takes its status from their runs, batches and cards.
  goal: [goalKeys.all],
  // The digest's Decisions and Deviations rows.
  deviation: [goalKeys.all],
  // The Knowledge view. Confirming a principle resolves its proposal and accepting a proposal confirms
  // its principle, and any change to a record changes where it came from (retired, replaced), so the
  // three entities refetch the same lists. A decision is also a digest row. An open Plan view's converted
  // row reads its record's state (withdrawn or replaced, and retired for a principle), so a change made
  // outside the view (an MCP tool, a lane) refetches the conversations too.
  decision: [...KNOWLEDGE, goalKeys.all, shapeKeys.all],
  principle: [...KNOWLEDGE, shapeKeys.all],
  proposal: KNOWLEDGE,
  // A conversation's transcript, proposals, round and turn all change under this one event, and a
  // round changes how many rows wait in the sidebar.
  shape: [shapeKeys.all, chatKeys.all],
  // An explore conversation stored or changed an item, or moved state: its items and its state.
  conversation: [conversationKeys.all, chatKeys.all],
  // A chat was created, renamed, moved, archived or touched: the open tabs and Recent.
  chat: [chatKeys.all, chatWorkKeys.all, taskSessionKeys.all],
  // A pass opening, a turn starting or ending, a page Ready or signed off, a close step: each changes
  // the pass and its pages' turns.
  pass: [passKeys.all, folderKeys.all, taskSessionKeys.all],
  board_column: [['board-columns'], CANDIDATES],
  network_hosts: [NETWORK_HOSTS_KEY],
  // One account's sign-in to one of the builder's MCP servers started, ended or was cancelled; an ended
  // Connect Linear also turns the project's Linear on.
  mcp_sign_in: [
    trustKeys.signIns,
    LINEAR_SIGN_INS_KEY,
    FIGMA_SIGN_INS_KEY,
    PROJECT_INTEGRATIONS_KEY,
  ],
  // gh's login changed under a Sign In; the status and the setup check's gh row read it.
  github: [githubKeys.status, queryKeys.system],
  // A batch's state shows on the board's strip and in its list; cancelling an abandoned batch's work moves tasks.
  batch: [queryKeys.projects, ['batches'], ...WORK, CANDIDATES, rigorFiguresKeys.all],
  // Lanes changing can switch keep-awake on or off. A pass page's state is its run's, paused or resumed
  // by a usage limit with no pass event.
  workstream: [
    ...WORK,
    queryKeys.keepAwake,
    CANDIDATES,
    humanTouchKeys.all,
    passKeys.live,
    folderKeys.all,
    taskSessionKeys.all,
    shapeKeys.startCountsAll,
  ],
  // A session's span says which tasks ran that day.
  session: [...WORK, humanTouchKeys.all],
  claim: [...WORK, CANDIDATES],
  handoff: WORK,
  evidence: WORK,
  // An account pause moves workstreams, which send their own events.
  account: [accountKeys.all, modelKeys.all],
  inbox: [queryKeys.inbox, ['workstreams'], goalKeys.all, humanTouchKeys.all, cardTypesKeys.all],
  app_setting: [queryKeys.keepAwake, queryKeys.agentSkill],
  // Settings › People lists people and the routes each answers; Who Answers and a task's question routes
  // name them. Step plans, which only the batch sheet shows, are not read from people; they follow personas,
  // and so do the Models page's picks.
  persona: [CANDIDATES, modelKeys.all, PERSONAS_KEY],
  person: [PEOPLE_KEY, ROUTING_RULES_KEY, QUESTION_ROUTES_KEY],
  // Placement follows the live connection: a sent card is Waiting's while Slack is connected, so every list
  // and every count is read again.
  slack: [SLACK_KEY, queryKeys.inbox, ['inbox-rows']],
  stakeholder_timers: [TIMERS_KEY],
  // A send going out or coming back changes how many questions a project has out, which its Slack Select reads.
  stakeholder_send: [queryKeys.inbox, ['workstreams'], goalKeys.all, PROJECT_INTEGRATIONS_KEY],
  // The Models page lists profiles and what each account offers.
  model_profile: [CANDIDATES, modelKeys.all],
  account_models: [modelKeys.all],
  // Settings › Playbook reads the playbook and the kinds, and the picks follow both; a kind also changes which
  // rigors a task may take and what its card shows.
  playbook: [playbookKeys.all, modelKeys.all],
  kind: [KINDS_KEY, modelKeys.all, ['tasks'], CANDIDATES],
  routing_rules: [CANDIDATES, ROUTING_RULES_KEY, QUESTION_ROUTES_KEY],
  benchmarks: [CANDIDATES],
  // The holds the rail's status line shows: the daemon says when the shown set changes.
  app: [statusKeys.all],
};

/** What to refetch for one event type, on top of its entity type's entries. */
export const EVENT_INVALIDATIONS: Readonly<Partial<Record<EventType, readonly QueryKey[]>>> = {
  // A session's tokens and dollars are recorded when it ends, not on its per-tool-call events.
  'session.ended': [accountKeys.usage],
  // A builder message, an agent's reply or a notice joined a task's thread (its conversation's items
  // follow their own events); a reply ends a turn, so what streams is read again, and a message to a
  // page makes it working before its turn starts.
  'task.message_added': [passKeys.turnsAll, passKeys.live, liveKeys.all],
  // A picture of a task's page was kept: its thread and its drawer show it.
  'task.screen_added': [screenKeys.all],
  // The reporter's update on a task's Linear issue was owed, recorded, withheld or failed.
  'linear_post.changed': [linearPostKeys.all],
  // A notice that asks nothing joined Activity, and its task's drawer lists it.
  'notice.posted': [activityKeys.all],
  // A turn began or ended: what streams is read again, so an item that finished leaves it, and what the turn
  // changed in the session's worktree is read again.
  'conversation.state': [liveKeys.all, chatWorkKeys.all],
};

export function eventStreamUrl(conn: DaemonConnection, after: number): string {
  const url = new URL('/events/stream', conn.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('after', String(after));
  url.searchParams.set('token', conn.token);
  return url.toString();
}

/**
 * One live event stream. A fresh UI starts at the daemon's head; afterwards it resumes from the
 * last seq it saw, across drops and across a daemon restart on a new port, so nothing is lost
 * or applied twice. Each event refetches the queries it touches.
 */
export function useEventStream(onEvent?: (event: DaemonEvent) => void): void {
  const { client, connection } = useDaemon();
  const queryClient = useQueryClient();
  // Kept across reconnects: a restarted daemon has the same database, so its log continues this seq.
  // A daemon on a wiped data dir starts over at 1; the UI then needs a reload to see its events.
  const lastSeq = useRef<number | null>(null);
  const listener = useRef(onEvent);
  useEffect(() => {
    listener.current = onEvent;
  });

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    function receive(raw: unknown): void {
      if (typeof raw !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return;
      }
      // A live frame is never stored and takes no seq (sessions spec §6.5): the cursor stays.
      const frame = ConversationDeltaFrame.safeParse(json);
      if (frame.success) {
        writeLiveFrame(queryClient, frame.data);
        return;
      }
      const parsed = DaemonEvent.safeParse(json);
      if (!parsed.success) return;
      const event = parsed.data;
      // The daemon sends each seq once; a resend at a reconnect seam is ignored.
      if (lastSeq.current !== null && event.seq <= lastSeq.current) return;
      lastSeq.current = event.seq;
      for (const queryKey of [
        ...(INVALIDATIONS[event.entityType] ?? []),
        ...(EVENT_INVALIDATIONS[event.type] ?? []),
      ])
        void queryClient.invalidateQueries({ queryKey });
      applyInboxEvent(queryClient, client, event);
      // A lane's design check, or its verdict, was kept: only that task's drawer asks again.
      if (event.type === EventType.TaskChanged && typeof event.data['designCheckId'] === 'string')
        void queryClient.invalidateQueries({
          queryKey: designCheckKeys.of(TaskId.parse(event.entityId)),
        });
      if (event.type === EventType.AccountLoginEnded) {
        const ended = AccountLoginEndedData.safeParse(event.data);
        if (ended.success)
          queryClient.setQueryData(accountLoginKey(ended.data.accountId), ended.data);
      }
      if (event.type === EventType.GithubLoginEnded) {
        const ended = GithubLoginEndedData.safeParse(event.data);
        if (ended.success) queryClient.setQueryData(githubKeys.loginEnd, ended.data);
      }
      // One arrives per tool call: a pass lane's is written into its page, never refetched.
      if (event.type === EventType.SessionActivity) writePassActivity(queryClient, event);
      listener.current?.(event);
    }

    function retry(): void {
      if (stopped) return;
      const delay = Math.min(STREAM_RETRY_BASE_MS * 2 ** attempt, STREAM_RETRY_MAX_MS);
      attempt += 1;
      timer = setTimeout(() => {
        void open();
      }, delay);
    }

    async function open(): Promise<void> {
      let after = lastSeq.current;
      if (after === null) {
        try {
          const head = await client.events.head.$get(undefined, {
            init: { signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) },
          });
          const seq = (await readJson(head, EventsHead)).seq;
          // A stale effect (StrictMode, a new connection) must not touch the cursor, and the
          // cursor only moves forward.
          if (stopped) return;
          lastSeq.current = Math.max(lastSeq.current ?? seq, seq);
          after = lastSeq.current;
        } catch {
          retry();
          return;
        }
      }
      if (stopped) return;
      const ws = new WebSocket(eventStreamUrl(connection, after));
      socket = ws;
      ws.addEventListener('open', () => {
        attempt = 0;
        // Refetch what's on screen once per open. After a drop, anything could have changed. On the first
        // open, an event between a list fetch and the head read would otherwise never be applied.
        void queryClient.invalidateQueries();
      });
      ws.addEventListener('message', (message) => {
        receive(message.data);
      });
      ws.addEventListener('close', () => {
        if (socket !== ws) return;
        socket = null;
        retry();
      });
    }

    void open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      const ws = socket;
      socket = null;
      ws?.close();
    };
  }, [client, connection, queryClient]);
}
