import { DaemonEvent, EventsHead, type EventType } from '@10db/contracts';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { readJson } from './client';
import type { DaemonConnection } from './connection';
import { useDaemon } from './provider';
import { accountKeys } from './account-queries';
import { goalKeys } from './goal-queries';
import { humanTouchKeys } from './human-touch-queries';
import { NETWORK_HOSTS_KEY } from './network-host-queries';
import { queryKeys } from './queries';
import { shapeKeys } from './shape-queries';

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
  project: [queryKeys.projects, CANDIDATES],
  task: [['tasks'], goalKeys.all, CANDIDATES],
  // A goal's strip counts its tasks and takes its status from their runs, batches and cards.
  goal: [goalKeys.all],
  // The digest's Decisions and Deviations rows.
  deviation: [goalKeys.all],
  // The Knowledge view. Confirming a principle resolves its proposal and accepting a proposal confirms
  // its principle, and any change to a record changes where it came from (retired, replaced), so the
  // three entities refetch the same lists. A decision is also a digest row. An open Plan view's converted
  // row reads its record's state (retired, withdrawn, replaced), so a change made outside the view
  // (an MCP tool, a lane) refetches the conversations too.
  decision: [...KNOWLEDGE, goalKeys.all, shapeKeys.all],
  principle: [...KNOWLEDGE, shapeKeys.all],
  proposal: KNOWLEDGE,
  // A conversation's transcript, proposals, round and turn all change under this one event.
  shape: [shapeKeys.all],
  board_column: [['board-columns'], CANDIDATES],
  network_hosts: [NETWORK_HOSTS_KEY],
  // A batch's state shows on the board's strip and in its list; cancelling an abandoned batch's work moves tasks.
  batch: [queryKeys.projects, ['batches'], ...WORK, CANDIDATES],
  // Lanes changing can switch keep-awake on or off.
  workstream: [...WORK, queryKeys.keepAwake, CANDIDATES, humanTouchKeys.all],
  // A session's span says which tasks ran that day.
  session: [...WORK, humanTouchKeys.all],
  claim: [...WORK, CANDIDATES],
  handoff: WORK,
  evidence: WORK,
  // An account pause moves workstreams, which send their own events.
  account: [accountKeys.all],
  inbox: [queryKeys.inbox, ['workstreams'], goalKeys.all, humanTouchKeys.all],
  app_setting: [queryKeys.keepAwake],
  // Step plans, which only the batch sheet shows, follow these; no view reads `person`.
  persona: [CANDIDATES],
  person: [],
  flow: [queryKeys.flows, CANDIDATES],
  model_profile: [CANDIDATES],
  team: [CANDIDATES],
  routing_rules: [CANDIDATES],
  benchmarks: [CANDIDATES],
};

/** What to refetch for one event type, on top of its entity type's entries. */
export const EVENT_INVALIDATIONS: Readonly<Partial<Record<EventType, readonly QueryKey[]>>> = {
  // A session's tokens and dollars are recorded when it ends, not on its per-tool-call events.
  'session.ended': [accountKeys.usage],
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
