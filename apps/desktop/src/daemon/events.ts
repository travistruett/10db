import { DaemonEvent, EventsHead } from '@10db/contracts';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { readJson } from './client';
import type { DaemonConnection } from './connection';
import { useDaemon } from './provider';
import { queryKeys } from './queries';

export const STREAM_RETRY_BASE_MS = 500;
export const STREAM_RETRY_MAX_MS = 10_000;
/** How long the head fetch may take before the stream retries. */
const HEAD_TIMEOUT_MS = 2_000;

const WORK: readonly QueryKey[] = [['workstreams'], ['tasks']];

/** What to refetch when an event about an entity type arrives. */
export const INVALIDATIONS: Readonly<Record<string, readonly QueryKey[]>> = {
  project: [queryKeys.projects],
  task: [['tasks']],
  board_column: [['board-columns']],
  // A batch's state shows on the board's strip; cancelling an abandoned batch's work moves tasks.
  batch: [queryKeys.projects, ...WORK],
  // Lanes changing can switch keep-awake on or off.
  workstream: [...WORK, queryKeys.keepAwake],
  session: WORK,
  claim: WORK,
  handoff: WORK,
  evidence: WORK,
  provider: WORK,
  inbox: [queryKeys.inbox, ['workstreams']],
  app_setting: [queryKeys.keepAwake],
  // No view reads these entity types; the entries make them known.
  persona: [],
  person: [],
  flow: [queryKeys.flows],
  model_profile: [],
  team: [],
  routing_rules: [],
  benchmarks: [],
  // `proposal` (from proposal.resolved) has no view to refresh; the card that resolved it sends its own inbox event.
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
      for (const queryKey of INVALIDATIONS[event.entityType] ?? [])
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
