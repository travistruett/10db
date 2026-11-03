import { ScreenRenderRequest } from '@10db/contracts';
import { useEffect } from 'react';
import { readJson, type DaemonClient } from '../daemon/client';
import { useDaemon } from '../daemon/provider';
import { captureFrame } from './capture-frame';
import { drawScreen, type DrawResult } from './draw-screen';

// Shape spec §5.5. The window's side of `see_screen`: it asks the daemon for a screen to draw (a long
// poll that answers empty when there is none), draws it in a hidden frame and answers with the picture
// or the reason there is none. It renders nothing itself.

/** How long a frame has to load its screen: the daemon gives up on the window a little after. */
const DRAW_TIMEOUT_MS = 15_000;
/** How long to wait before asking again after the daemon could not be asked. */
const RETRY_MS = 3_000;

async function draw(request: ScreenRenderRequest, daemon: string): Promise<DrawResult> {
  return drawScreen({
    request,
    daemon,
    origin: window.location.origin,
    doc: document,
    capture: captureFrame,
    timeoutMs: DRAW_TIMEOUT_MS,
  });
}

async function answer(
  client: DaemonClient,
  request: ScreenRenderRequest,
  result: DrawResult,
): Promise<void> {
  const param = { requestId: request.id };
  if (result.ok) await client.screens[':requestId'].image.$post({ param, json: result.image });
  else await client.screens[':requestId'].refuse.$post({ param, json: { reason: result.reason } });
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
          await answer(client, request, await drawOne(request, daemon));
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
