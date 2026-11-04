import { ScreenRefusalInput, ScreenRenderRequest } from '@10db/contracts';
import { useEffect } from 'react';
import { readJson, type DaemonClient } from '../daemon/client';
import { useDaemon } from '../daemon/provider';
import { captureFrame } from './capture-frame';
import { drawScreen, WINDOW_HIDDEN, type DrawResult } from './draw-screen';

// Shape spec §5.5. The window's side of `see_screen`: it asks the daemon for a screen to draw (a long
// poll that answers empty when there is none), draws it in a hidden frame and answers with the picture
// or the reason there is none. A window out of sight keeps asking, so the daemon can't tell: it is the
// window that refuses, at once. It renders nothing itself.

/** How long a frame has to load its screen. */
const LOAD_TIMEOUT_MS = 15_000;
/** How long a whole draw has, load and capture: a little inside the 20 s the daemon gives the window. */
const DRAW_BUDGET_MS = 19_000;
/** Said when the daemon will not take the window's own reason. */
const REASON_LOST = 'The window could not tell the daemon why the screen was not drawn.';
const REASON_MAX = ScreenRefusalInput.shape.reason.maxLength ?? 300;

/** A reason the daemon will take: the window does not cut its reasons, a daemon error can run long. */
function fitReason(reason: string): string {
  if (reason.length <= REASON_MAX) return reason;
  let cut = reason.slice(0, REASON_MAX - 1);
  // Not half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}
/** How long to wait before asking again after the daemon could not be asked. */
const RETRY_MS = 3_000;

async function draw(request: ScreenRenderRequest, daemon: string): Promise<DrawResult> {
  return drawScreen({
    request,
    daemon,
    origin: window.location.origin,
    doc: document,
    capture: captureFrame,
    timeoutMs: LOAD_TIMEOUT_MS,
    budgetMs: DRAW_BUDGET_MS,
  });
}

async function answer(
  client: DaemonClient,
  request: ScreenRenderRequest,
  result: DrawResult,
): Promise<void> {
  const param = { requestId: request.id };
  const refuse = (reason: string) =>
    client.screens[':requestId'].refuse.$post({ param, json: { reason: fitReason(reason) } });
  if (result.ok) {
    const res = await client.screens[':requestId'].image.$post({ param, json: result.image });
    if (!res.ok)
      await refuse(
        `The daemon would not keep the picture of the screen (HTTP ${String(res.status)}).`,
      );
    return;
  }
  const res = await refuse(result.reason);
  // A refusal the daemon turns away would leave the session waiting for its own timeout.
  if (!res.ok) await refuse(REASON_LOST);
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export interface ScreenRenderHostProps {
  /** Draws one screen; the real one by default. */
  readonly draw?: (request: ScreenRenderRequest, daemon: string) => Promise<DrawResult>;
}

export function ScreenRenderHost({ draw: drawOne = draw }: ScreenRenderHostProps) {
  const { client, connection } = useDaemon();
  const daemon = connection.url;
  useEffect(() => {
    const stop = new AbortController();
    void (async () => {
      while (!stop.signal.aborted) {
        try {
          const res = await client.screens.claim.$post(undefined, {
            init: { signal: stop.signal },
          });
          // No screen was wanted this time: ask again.
          if (res.status === 204) continue;
          const request = await readJson(res, ScreenRenderRequest);
          const result: DrawResult =
            document.visibilityState === 'visible'
              ? await drawOne(request, daemon)
              : { ok: false, reason: WINDOW_HIDDEN };
          await answer(client, request, result);
        } catch {
          // The daemon is gone, or is a version without screens: ask again later.
          await wait(RETRY_MS, stop.signal);
        }
      }
    })();
    return () => {
      stop.abort();
    };
  }, [client, daemon, drawOne]);
  return null;
}
