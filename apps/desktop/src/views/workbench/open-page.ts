import type { PassId, TaskId } from '@10db/contracts';
import { useState } from 'react';
import { appPageUrl, openAppPage } from '../../desktop/tauri';

// Workbench spec §4.3, design review D18: Open Page's first click for a page in a pass opens the page
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
}

export interface OpenPageControl {
  /** The page has been opened in this pass: the button copies its link. */
  readonly opened: boolean;
  /** Why the page could not be opened or its link copied; null when nothing failed. */
  readonly refusal: string | null;
  /** Opens the page, or copies its link once it has been opened. */
  readonly act: () => Promise<void>;
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

/** The app address and the route to open, or why there are none. */
function addressOf(target: OpenPageTarget): { readonly appUrl: string; readonly route: string } {
  if (target.appUrl === null) throw new Error('No app address is set for this project.');
  if (target.route === null) throw new Error('This page names no route.');
  return { appUrl: target.appUrl, route: target.route };
}

/** Open Page, then Copy Link, for one page of a pass. */
export function useOpenPage(target: OpenPageTarget): OpenPageControl {
  const [openedHere, setOpenedHere] = useState<ReadonlySet<string>>(new Set());
  const [refused, setRefused] = useState<{ readonly key: string; readonly reason: string } | null>(
    null,
  );
  const key = `${target.passId}/${target.taskId}`;
  const opened = openedHere.has(key) || readOpened(target.passId).includes(target.taskId);
  const act = async (): Promise<void> => {
    try {
      const { appUrl, route } = addressOf(target);
      if (opened) {
        await navigator.clipboard.writeText(appPageUrl(appUrl, route));
      } else {
        await openAppPage(appUrl, route);
        rememberOpened(target.passId, target.taskId);
        setOpenedHere((held) => new Set(held).add(key));
      }
      setRefused(null);
    } catch (error) {
      setRefused({ key, reason: error instanceof Error ? error.message : String(error) });
    }
  };
  return { opened, refusal: refused?.key === key ? refused.reason : null, act };
}
