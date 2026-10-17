import type { InboxItemDto } from '@10db/contracts';
import { invoke } from '@tauri-apps/api/core';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

export interface TrayCounts {
  readonly lanes: number;
  readonly inbox: number;
  readonly keepAwake: boolean;
}

/** True inside the Tauri webview; false in a plain browser (Vite dev, Playwright, tests). */
export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
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

/** A macOS notification for a new card, only while the window isn't focused (spec §7). */
export async function notifyNewCard(item: InboxItemDto): Promise<void> {
  if (!isTauri() || document.hasFocus()) return;
  if (!(await canNotify())) return;
  sendNotification({
    title: item.kind === 'permission' ? '10db needs a permission' : '10db has a question',
    body: item.title,
  });
}
