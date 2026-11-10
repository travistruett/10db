import { InboxKind, type InboxItemDto } from '@10db/contracts';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
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
 * `target="_blank"` link. The capability allows only `https://github.com/*` and
 * `https://artificialanalysis.ai/*`, whose credit beside its scores links its site, besides the sign-in page
 * `openSignInPage` opens and the loopback pages `openAppPage` opens through the shell's own command.
 */
export function openInBrowser(url: string): Promise<void> {
  return openUrl(url);
}

/** Thrown when a page address is not the selected project's own loopback app address. */
export class AppPageRefusedError extends Error {
  override readonly name = 'AppPageRefusedError';
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The address to open for `route` on the project's app, or a refusal. The shell's
 * `open_app_page` command refuses anything but a loopback address, so this check is what holds
 * a window to one project's address: the app address must be a loopback `http(s)` origin, and
 * the address opened must have exactly that origin. Throws `AppPageRefusedError`.
 */
export function appPageUrl(appUrl: string, route: string): string {
  const app = URL.parse(appUrl);
  if (app === null || (app.protocol !== 'http:' && app.protocol !== 'https:')) {
    throw new AppPageRefusedError(`${appUrl} is not an http address`);
  }
  if (!LOOPBACK_HOSTNAMES.has(app.hostname) && !app.hostname.endsWith('.localhost')) {
    throw new AppPageRefusedError(`${app.origin} is not a loopback address`);
  }
  const page = route.startsWith('/') ? URL.parse(route, app.origin) : null;
  if (page?.origin !== app.origin) {
    throw new AppPageRefusedError(`${route} is not a page of ${app.origin}`);
  }
  return page.href;
}

/**
 * Opens one page of the selected project's app in the default browser; a plain browser opens a tab.
 * Refuses (rejects with `AppPageRefusedError`) unless `appUrl` is a loopback `http(s)` origin and
 * `route` stays on it.
 */
export function openAppPage(appUrl: string, route: string): Promise<void> {
  try {
    const url = appPageUrl(appUrl, route);
    if (isTauri()) return invoke('open_app_page', { url });
    const opened = window.open(url, '_blank');
    if (opened === null) return Promise.reject(new Error('the browser blocked the page'));
    opened.opener = null;
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Opens the page an agent names for a browser sign-in. The capability allows only
 * `https://auth.openai.com/*` besides GitHub and Artificial Analysis; a plain browser opens a tab.
 */
export function openSignInPage(url: string): Promise<void> {
  if (isTauri()) return openUrl(url);
  // A blocked pop-up answers null; `noopener` would answer null for a page that did open, so the
  // opened window is cut off from the app by hand. `noreferrer` would also answer null, so this path
  // (a plain browser: development and tests) sends a Referer rather than give up pop-up detection.
  const opened = window.open(url, '_blank');
  if (opened === null) return Promise.reject(new Error('the browser blocked the sign-in page'));
  opened.opener = null;
  return Promise.resolve();
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

/**
 * Gives the native window the app's color scheme rather than the system's, so the traffic lights, menus
 * and scrollbars match the app. A no-op in a browser.
 */
export async function setWindowTheme(scheme: 'light' | 'dark'): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().setTheme(scheme);
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
  [InboxKind.Check]: '10db has work for you to check',
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
