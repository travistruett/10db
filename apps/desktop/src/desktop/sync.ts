import { EventType, InboxItemId, LANE_STATES, WorkstreamState } from '@10db/contracts';
import { useComputedColorScheme } from '@mantine/core';
import { CancelledError, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useEventStream } from '../daemon/events';
import { livePassesOptions } from '../daemon/pass-queries';
import { useDaemon } from '../daemon/provider';
import { inboxQueryOptions, useKeepAwake, useWorkstreams } from '../daemon/queries';
import { useSelectedProject } from '../shell/selected-project';
import { useOpenInboxCount } from '../views/inbox/inbox-count';
import {
  listenForPassClicks,
  notifyPassReady,
  readyPageOf,
  type PassPageTarget,
} from './notify-pass';
import { shouldNotifyOpened, triagedToBuilder } from './notify-card';
import { bringWindowForward, isTauri, notifyNewCard, setWindowTheme, updateTray } from './tauri';

/** How often a card's read is asked again when an event's refetch of the Inbox cancels it. */
const INBOX_READ_ATTEMPTS = 3;

/** Workstreams that hold a lane or wait on the builder: what the menu bar counts as running. */
const BUSY_STATES: readonly WorkstreamState[] = [...LANE_STATES, WorkstreamState.WaitingHuman];

/**
 * The one event stream, the menu-bar counts, new-card notifications and the native window's theme.
 * Mounted once by AppLayout.
 */
export function useDesktopSync(): void {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { select } = useSelectedProject();
  const lanes =
    useWorkstreams({ active: true }).data?.filter((w) => BUSY_STATES.includes(w.state)).length ?? 0;
  const inbox = useOpenInboxCount();
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

  // A click on a ready notification selects its project and page and brings the window forward. The
  // listener is registered once, at mount: a notification sent before it would never report a click.
  const openPage = useRef<(target: PassPageTarget) => void>(() => undefined);
  useEffect(() => {
    openPage.current = (target) => {
      select(target.projectId);
      void navigate({ to: '/workbench', search: { task: target.taskId } });
      bringWindowForward().catch((error: unknown) => {
        console.warn('10db: could not bring the window forward', error);
      });
    };
  });
  useEffect(
    () =>
      listenForPassClicks((target) => {
        openPage.current(target);
      }),
    [],
  );

  /** The open cards; a read cancelled by the next event's refetch of the Inbox is asked again. */
  async function openCards() {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await queryClient.query(inboxQueryOptions(client));
      } catch (error) {
        if (!(error instanceof CancelledError) || attempt >= INBOX_READ_ATTEMPTS) throw error;
      }
    }
  }

  async function notifyOpened(id: string): Promise<void> {
    const items = await openCards();
    const opened = InboxItemId.safeParse(id);
    if (!opened.success) return;
    const item = items.find((candidate) => candidate.id === opened.data);
    if (!item) return;
    const ready = readyPageOf(item);
    if (ready === null) {
      if (shouldNotifyOpened(item)) await notifyNewCard(item);
      return;
    }
    // Without the passes the notification names the item, not the page: it is never dropped for them.
    const passes = await queryClient.query(livePassesOptions(client)).catch(() => []);
    await notifyPassReady(
      item,
      ready,
      passes.find((view) => view.pass.id === ready.passId),
    );
  }

  useEventStream((event) => {
    if (!isTauri()) return;
    // A card placed with the builder after triage is as new to them as one that opened there.
    const triaged = event.type === EventType.InboxTriaged && triagedToBuilder(event.data);
    if (event.type !== EventType.InboxOpened && !triaged) return;
    notifyOpened(event.entityId).catch((error: unknown) => {
      console.warn('10db: could not notify about a new card', error);
    });
  });
}
