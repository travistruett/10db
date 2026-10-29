import { EventType, InboxItemId, LANE_STATES, WorkstreamState } from '@10db/contracts';
import { useComputedColorScheme } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useEventStream } from '../daemon/events';
import { useDaemon } from '../daemon/provider';
import { inboxQueryOptions, useInbox, useKeepAwake, useWorkstreams } from '../daemon/queries';
import { inboxRowCount } from '../views/inbox/inbox-rows';
import { isTauri, notifyNewCard, setWindowTheme, updateTray } from './tauri';

/** Workstreams that hold a lane or wait on the builder: what the menu bar counts as running. */
const BUSY_STATES: readonly WorkstreamState[] = [...LANE_STATES, WorkstreamState.WaitingHuman];

/**
 * The one event stream, the menu-bar counts, new-card notifications and the native window's theme.
 * Mounted once by AppLayout.
 */
export function useDesktopSync(): void {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const lanes =
    useWorkstreams({ active: true }).data?.filter((w) => BUSY_STATES.includes(w.state)).length ?? 0;
  const inbox = inboxRowCount(useInbox().data ?? []);
  const keepAwake = useKeepAwake().data?.active ?? false;

  const scheme = useComputedColorScheme('dark');

  useEffect(() => {
    updateTray({ lanes, inbox, keepAwake });
  }, [lanes, inbox, keepAwake]);

  useEffect(() => {
    setWindowTheme(scheme).catch((error: unknown) => {
      console.warn('10db: could not set the window theme', error);
    });
  }, [scheme]);

  async function notifyOpened(id: string): Promise<void> {
    const items = await queryClient.query(inboxQueryOptions(client));
    const opened = InboxItemId.safeParse(id);
    if (!opened.success) return;
    const item = items.find((candidate) => candidate.id === opened.data);
    if (item) await notifyNewCard(item);
  }

  useEventStream((event) => {
    if (event.type !== EventType.InboxOpened || !isTauri()) return;
    notifyOpened(event.entityId).catch((error: unknown) => {
      console.warn('10db: could not notify about a new card', error);
    });
  });
}
