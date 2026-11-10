import {
  InboxKind,
  PassCheckDetail,
  type InboxItemDto,
  type PassViewDto,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { onAction, sendNotification } from '@tauri-apps/plugin-notification';
import { z } from 'zod';
import type { ShownNotification } from '../views/workbench/focus-target';
import { canNotify, isTauri } from './tauri';

// Workbench spec §4.3, design review D12: a page becoming Ready notifies "Settings is ready". Clicking
// the notification selects that page. macOS reports the click to the listener `onAction` registered
// before the notification was sent, with the notification's numeric id, so the listener is registered
// once, at mount, and every send waits for it. A click that is never reported is covered by the
// focus fallback (`focus-target.ts`), which reads the notifications shown here.

/** The page a ready notification is about. */
export interface PassPageTarget {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
}

/** How many shown notifications are remembered: the focus fallback reads only the last 10 seconds. */
const REMEMBERED = 20;

interface Shown extends ShownNotification {
  readonly id: number;
  readonly projectId: ProjectId;
}

let shown: Shown[] = [];
let nextId = 1;
let listening: Promise<void> | null = null;

/** The ready notifications shown lately, for the focus fallback. */
export function shownPassNotifications(): readonly ShownNotification[] {
  return shown;
}

/** Marks a page's notifications acted on: the page was selected by its click or the fallback. */
export function markPassNotificationsActed(taskId: TaskId): void {
  shown = shown.map((n) => (n.taskId === taskId ? { ...n, acted: true } : n));
}

/** The page a `check` item says is Ready, when its detail is a Workbench pass's; else null. */
export function readyPageOf(item: InboxItemDto): PassCheckDetail | null {
  if (item.kind !== InboxKind.Check) return null;
  const detail = PassCheckDetail.safeParse(item.detail);
  return detail.success ? detail.data : null;
}

/**
 * What the plugin reports for a click (tauri-plugin-notification 2.8 `ActionPerformed`): the action,
 * `tap` for the notification itself, and the notification as shown, whose id names the page.
 */
const ClickedNotification = z.object({ notification: z.object({ id: z.number() }) });

/**
 * Registers the listener for clicks on ready notifications, for as long as the app is mounted; the
 * returned function removes it. Sends wait for the registration. A no-op in a browser.
 */
export function listenForPassClicks(onClick: (target: PassPageTarget) => void): () => void {
  if (!isTauri()) return () => undefined;
  const registered = onAction((performed) => {
    const clicked = ClickedNotification.safeParse(performed);
    if (!clicked.success) return;
    const target = shown.find((n) => n.id === clicked.data.notification.id);
    if (target === undefined) return;
    // The click is the builder's answer to every notification on screen: the focus that follows it
    // must not take another one, a later one, as the click.
    shown = shown.map((n) => ({ ...n, acted: true }));
    onClick({ projectId: target.projectId, taskId: target.taskId });
  });
  const mine = registered.then(() => undefined);
  listening = mine;
  registered.catch((error: unknown) => {
    console.warn('10db: could not listen for notification clicks', error);
  });
  return () => {
    if (listening === mine) listening = null;
    registered.then((listener) => listener.unregister()).catch(() => undefined);
  };
}

/**
 * "Settings is ready" for a Ready page of `pass`, only while the window isn't focused, and only after
 * the click listener is registered.
 */
export async function notifyPassReady(
  item: InboxItemDto,
  detail: PassCheckDetail,
  pass: PassViewDto | undefined,
): Promise<void> {
  if (!isTauri() || listening === null) return;
  await listening;
  if (document.hasFocus() || !(await canNotify())) return;
  const area = pass?.pages.find((page) => page.taskId === detail.taskId)?.area;
  const id = nextId;
  nextId += 1;
  shown = [
    ...shown,
    { id, projectId: item.projectId, taskId: detail.taskId, at: Date.now(), acted: false },
  ].slice(-REMEMBERED);
  sendNotification({
    id,
    title: area === undefined ? item.title : `${area} is ready`,
    body: item.title,
  });
}
