import {
  DevUiConnectionDto,
  handOffTo,
  PreviewSignInDto,
  type PassId,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { useState } from 'react';
import { readJson } from '../../daemon/client';
import { useDaemon, useDaemonStatus } from '../../daemon/provider';
import { openPreview, previewAvailable } from '../../desktop/preview';
import { appPageUrl, openAppPage } from '../../desktop/tauri';

// Workbench spec §4.3, design review D18: Open in Browser's first click for a page in a pass opens it
// in the builder's browser; after that it reads Copy Link, because the builder's tab is open already and
// hot reload keeps it current. What was opened is kept per pass in this browser; when the browser keeps
// nothing, the button still turns for as long as the view is open.

export interface OpenPageTarget {
  readonly passId: PassId;
  readonly taskId: TaskId;
  /** The page's route, or null when its area names none. */
  readonly route: string | null;
  /** The project's app address, or null when none is set. */
  readonly appUrl: string | null;
  /** The page's project, its folder and the page's name, for the Preview window; none, no Preview. */
  readonly preview?: {
    readonly projectId: ProjectId;
    readonly repoPath: string;
    readonly label: string;
  };
}

/** What stopped a page from opening, which says what can fix it. */
export const OpenFailure = {
  /** 10db's daemon didn't answer: trying again once it is back is the fix. */
  Daemon: 'daemon',
  /** The project's app address, route or dev login: Settings › App Preview is the fix. */
  Setup: 'setup',
  /** Anything else, such as the clipboard. */
  Other: 'other',
} as const;
export type OpenFailure = (typeof OpenFailure)[keyof typeof OpenFailure];

export interface OpenPageRefusal {
  /** What could not be done: "Couldn't open the Preview". */
  readonly title: string;
  /** Why, in a sentence. */
  readonly reason: string;
  readonly failure: OpenFailure;
  readonly retry: () => Promise<void>;
  readonly dismiss: () => void;
}

export interface OpenPageControl {
  /** The page has been opened in this pass: the button copies its link. */
  readonly opened: boolean;
  /** Why the page could not be opened or its link copied; null when nothing failed. */
  readonly refusal: OpenPageRefusal | null;
  /** Opens the page, or copies its link once it has been opened. */
  readonly act: () => Promise<void>;
  /** Opens the page whether or not it was opened before. */
  readonly launch: () => Promise<void>;
  /** Copies the page's link (⌘L), opened or not. */
  readonly copy: () => Promise<void>;
  /**
   * Opens the page in the project's Preview window, signed in with its dev login; null where there is
   * no Preview: outside the desktop app, and for 10db's own window, which the shell itself serves.
   */
  readonly preview: (() => Promise<void>) | null;
}

const storageKey = (passId: PassId): string => `tendb.workbench.opened.${passId}`;

function readOpened(passId: PassId): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(passId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function rememberOpened(passId: PassId, taskId: TaskId): void {
  try {
    const held = readOpened(passId);
    if (!held.includes(taskId))
      localStorage.setItem(storageKey(passId), JSON.stringify([...held, taskId]));
  } catch {
    // Kept in this view's state alone.
  }
}

interface Address {
  readonly appUrl: string;
  readonly route: string;
}

/** The app address and the route to open, or why there are none. */
function addressOf(target: OpenPageTarget): Address {
  if (target.appUrl === null) throw new Error('No app address is set for this project.');
  if (target.route === null) throw new Error('This page names no route.');
  return { appUrl: target.appUrl, route: target.route };
}

/** The origin of an app address, or null for none or one that doesn't parse. */
function originOf(appUrl: string | null): string | null {
  return appUrl === null ? null : (URL.parse(appUrl)?.origin ?? null);
}

/** Open in Browser, then Copy Link, for one page of a pass. */
export function useOpenPage(target: OpenPageTarget): OpenPageControl {
  const [openedHere, setOpenedHere] = useState<ReadonlySet<string>>(new Set());
  const [refused, setRefused] = useState<
    (Omit<OpenPageRefusal, 'dismiss'> & { readonly key: string }) | null
  >(null);
  const { client, connection } = useDaemon();
  const status = useDaemonStatus();
  const devUiOrigin = status.kind === 'connected' ? status.devUiOrigin : null;
  const key = `${target.passId}/${target.taskId}`;
  // 10db's own dev UI is handed the daemon's connection, whose port moves at each start, so its
  // button opens (and hands it again) every time instead of turning to Copy Link.
  const devUi = devUiOrigin !== null && originOf(target.appUrl) === devUiOrigin;
  const opened =
    !devUi && (openedHere.has(key) || readOpened(target.passId).includes(target.taskId));
  const daemonDown = status.kind !== 'connected';
  const attempt = async (
    title: string,
    step: (address: Address) => Promise<void>,
    setup = true,
  ): Promise<void> => {
    try {
      await step(addressOf(target));
      setRefused(null);
    } catch (error) {
      // A request that never reached the daemon fails as a TypeError ("Load failed" in WebKit).
      const unreachable = error instanceof TypeError || daemonDown;
      setRefused({
        key,
        title,
        reason: unreachable
          ? "10db's daemon isn't answering. It may be restarting; 10db reconnects on its own."
          : error instanceof Error
            ? error.message
            : String(error),
        failure: unreachable ? OpenFailure.Daemon : setup ? OpenFailure.Setup : OpenFailure.Other,
        retry: () => attempt(title, step, setup),
      });
    }
  };
  const copy = ({ appUrl, route }: Address) =>
    navigator.clipboard.writeText(appPageUrl(appUrl, route));
  const launch = () =>
    attempt("Couldn't open the page in your browser", async (address) => {
      // 10db's own dev UI gets the daemon's read-only dev UI token in the fragment, never the app's
      // own; a copied link carries neither.
      const handed = devUi
        ? await readJson(await client['dev-ui'].connection.$get(), DevUiConnectionDto)
        : null;
      await openAppPage(address.appUrl, address.route, (url) =>
        handed === null
          ? url
          : handOffTo(url, devUiOrigin, { url: connection.url, token: handed.token }),
      );
      rememberOpened(target.passId, target.taskId);
      setOpenedHere((held) => new Set(held).add(key));
    });
  const copyLink = () => attempt("Couldn't copy the page's link", copy, false);
  const act = () => (opened ? copyLink() : launch());
  const ownWindow = originOf(target.appUrl) === window.location.origin;
  const about = target.preview;
  const preview =
    about !== undefined && previewAvailable() && !devUi && !ownWindow
      ? () =>
          attempt("Couldn't open Mark Up Page", async ({ appUrl, route }) => {
            const signIn = await readJson(
              await client.projects[':projectId'].preview['sign-in'].$post({
                param: { projectId: about.projectId },
              }),
              PreviewSignInDto,
            );
            if (!signIn.ok) throw new Error(signIn.problem);
            await openPreview({
              projectId: about.projectId,
              appUrl,
              route,
              taskId: target.taskId,
              pageLabel: about.label,
              repoPath: about.repoPath,
            });
          })
      : null;
  return {
    opened,
    refusal:
      refused?.key === key
        ? {
            ...refused,
            dismiss: () => {
              setRefused(null);
            },
          }
        : null,
    act,
    launch,
    copy: copyLink,
    preview,
  };
}
