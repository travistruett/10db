import type { ChatId, InboxItemDto, ProjectId } from '@10db/contracts';
import { onAction, sendNotification } from '@tauri-apps/plugin-notification';
import { z } from 'zod';
import { takeNotificationId } from './notify-pass';
import { canNotify, isTauri } from './tauri';

// Sessions UI spec §5.7: a chat's reply and a chat's card each raise one notification while the window is
// not focused, and a click opens the tab. macOS reports the click to the listener registered before the
// notification was sent, with the notification's id, so the listener is registered once at mount and
// every send waits for it, as the Workbench's does.

/** The session a notification is about. */
export interface ChatTarget {
  readonly chatId: ChatId;
  readonly projectId: ProjectId;
}

/** How many shown notifications are remembered. */
const REMEMBERED = 20;

let shown: readonly (ChatTarget & { readonly id: number })[] = [];
let listening: Promise<void> | null = null;

const ClickedNotification = z.object({ notification: z.object({ id: z.number() }) });

/**
 * Registers the listener for clicks on a chat's notifications, for as long as the app is mounted; the
 * returned function removes it. A no-op in a browser.
 */
export function listenForChatClicks(onClick: (target: ChatTarget) => void): () => void {
  if (!isTauri()) return () => undefined;
  const registered = onAction((performed) => {
    const clicked = ClickedNotification.safeParse(performed);
    if (!clicked.success) return;
    const target = shown.find((n) => n.id === clicked.data.notification.id);
    if (target === undefined) return;
    onClick({ chatId: target.chatId, projectId: target.projectId });
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

async function send(target: ChatTarget, title: string, body: string): Promise<void> {
  if (!isTauri() || listening === null) return;
  await listening;
  if (document.hasFocus() || !(await canNotify())) return;
  const id = takeNotificationId();
  shown = [...shown, { id, ...target }].slice(-REMEMBERED);
  sendNotification({ id, title, body });
}

/** "{title} replied", with the reply's first line; nothing while the window has focus. */
export async function notifyChatReplied(
  target: ChatTarget,
  title: string,
  firstLine: string,
): Promise<void> {
  await send(target, `${title} replied`, firstLine);
}

/** "{title} needs you" for the card a chat raised; the one notification that card raises. */
export async function notifyChatCard(
  target: ChatTarget,
  title: string,
  item: InboxItemDto,
): Promise<void> {
  await send(target, `${title} needs you`, item.title);
}

/** A reply's first line: its first non-empty line, cut to a notification's width. */
export function firstLineOf(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim().slice(0, 140);
}
