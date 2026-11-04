import { Box } from '@mantine/core';
import { useIsFetching, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { DaemonRequestError } from '../daemon/client';
import { CRASH_ATTRIBUTE, CRASH_MESSAGE_ATTRIBUTE } from '../shell/view-boundary';
import { SCREEN_LABEL, type FrameMessage } from './draw-screen';
import { useRenderMode } from './render-context';

// Shape spec §5.5. What a frame shows in place of the shell: the screen alone, and a reporter that tells
// the window when the screen has drawn, or why it could not.

/** How long the screen must sit still, with nothing loading, before it counts as drawn. */
const SETTLE_MS = 400;

/** A read failing this way means the screen has no data to show; a 403 or 404 is part of a screen. */
function failsTheScreen(error: unknown): boolean {
  if (!(error instanceof DaemonRequestError)) return !(error instanceof DOMException);
  return error.status === 401 || error.status >= 500;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Verdict = FrameMessage | 'wait';

/** Whether the screen has drawn, has failed, or is not there yet. */
function judge(queryClient: QueryClient, label: string): Verdict {
  const queries = queryClient.getQueryCache().getAll();
  const failed = queries.find((q) => q.state.status === 'error' && failsTheScreen(q.state.error));
  if (failed !== undefined)
    return {
      source: 'tendb-screen',
      kind: 'refused',
      reason: `${label} failed to load: ${messageOf(failed.state.error)}`,
    };
  const text = document.body.textContent;
  // The boundary marks its own notice; text that merely quotes it (a task's title) is data to draw.
  const crash = document.querySelector(`[${CRASH_ATTRIBUTE}]`);
  if (crash !== null) {
    const message = crash.getAttribute(CRASH_MESSAGE_ATTRIBUTE);
    return {
      source: 'tendb-screen',
      kind: 'refused',
      reason: `${label} crashed: Something went wrong in ${crash.getAttribute(CRASH_ATTRIBUTE) ?? 'a view'}.${message ? ` (${message})` : ''}`,
    };
  }
  // Nothing has been asked for yet, or what was asked for is still to be drawn.
  if (!queries.some((q) => q.state.status === 'success') || text.trim() === '') return 'wait';
  return { source: 'tendb-screen', kind: 'ready' };
}

function Reporter() {
  const render = useRenderMode();
  const queryClient = useQueryClient();
  const fetching = useIsFetching();
  const routing = useRouterState({ select: (s) => s.status !== 'idle' || s.isLoading });
  const sent = useRef(false);
  const label = render === null ? 'The screen' : SCREEN_LABEL[render.screen];
  useEffect(() => {
    if (fetching > 0 || routing || sent.current) return;
    const timer = setTimeout(() => {
      const verdict = judge(queryClient, label);
      if (verdict === 'wait') return;
      sent.current = true;
      window.parent.postMessage(verdict, window.location.origin);
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [fetching, routing, queryClient, label]);
  return null;
}

/**
 * The drawing copies each element's computed style into an SVG image, which never lays out what
 * `content-visibility: auto` skips, so a transcript's blocks would come out blank.
 */
const DRAW_EVERYTHING = '* { content-visibility: visible !important; }';

/** The frame's root route: the screen, with the padding the app's own shell gives a view. */
export function RenderLayout() {
  return (
    <Box
      p="md"
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
      bg="var(--mantine-color-body)"
    >
      <style>{DRAW_EVERYTHING}</style>
      <Reporter />
      <Outlet />
    </Box>
  );
}
