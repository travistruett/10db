import { InboxKind, type InboxItemDto } from '@10db/contracts';
import { invoke } from '@tauri-apps/api/core';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';
import { mcpReview } from '../views/inbox/mcp-approval';

export interface TrayCounts {
  readonly lanes: number;
  readonly inbox: number;
  readonly keepAwake: boolean;
}

/** True inside the Tauri webview; false in a plain browser (Vite dev, Playwright, tests). */
export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

/**
 * Opens a web page in the default browser, for the desktop app, whose webview follows no
 * `target="_blank"` link. The capability allows only `https://github.com/*`.
 */
export function openInBrowser(url: string): Promise<void> {
  return openUrl(url);
}

/** Mirrors lanes, open cards and keep-awake into the menu bar. A no-op in a browser. */
export function updateTray(counts: TrayCounts): void {
  if (!isTauri()) return;
  invoke('update_tray', {
    lanes: counts.lanes,
    inbox: counts.inbox,
    keepAwake: counts.keepAwake,
  }).catch((error: unknown) => {
    console.warn('10db: could not update the menu bar', error);
  });
}

let permission: Promise<boolean> | null = null;

function canNotify(): Promise<boolean> {
  permission ??= (async () =>
    (await isPermissionGranted()) || (await requestPermission()) === 'granted')();
  return permission;
}

const KIND_TITLES: Readonly<Record<InboxKind, string>> = {
  [InboxKind.Question]: '10db has a question',
  [InboxKind.Permission]: '10db needs a permission',
  [InboxKind.Proposal]: '10db has a proposal',
  [InboxKind.Review]: '10db has a review for you',
  [InboxKind.Flag]: '10db flagged something',
};

/** What a new card's notification says first: what kind of card waits, so the builder can judge it unopened. */
export function notificationTitle(item: InboxItemDto): string {
  return mcpReview(item) ? '10db needs an MCP server approval' : KIND_TITLES[item.kind];
}

/** A macOS notification for a new card, only while the window isn't focused (spec §7). */
export async function notifyNewCard(item: InboxItemDto): Promise<void> {
  if (!isTauri() || document.hasFocus()) return;
  if (!(await canNotify())) return;
  sendNotification({
    title: notificationTitle(item),
    body: item.title,
  });
}
