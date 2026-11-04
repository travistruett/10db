import { ScreenName, type ScreenMediaType, type ScreenRenderRequest } from '@10db/contracts';
import { frameUrl } from './render-params';

// Shape spec §5.5. The window draws a screen for a session in a hidden frame of itself, and either has
// a picture or says why it has none. The frame runs the app under a render token; it is boxed in:
// sandboxed to scripts of its own origin, unseen, out of focus and out of reach of the pointer.

/** What the capture makes of the frame. */
export interface DrawnScreen {
  readonly mediaType: ScreenMediaType;
  /** The image's bytes, in base64. */
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

export type DrawResult =
  | { readonly ok: true; readonly image: DrawnScreen }
  | { readonly ok: false; readonly reason: string };

export interface DrawOptions {
  readonly request: ScreenRenderRequest;
  /** The daemon's address, which the frame reads its data from. */
  readonly daemon: string;
  /** The app's own origin: where the frame is loaded from, and the only origin it is heard from. */
  readonly origin: string;
  readonly doc: Document;
  /** Turns the loaded frame into an image. */
  capture(
    frame: HTMLIFrameElement,
    size: { readonly width: number; readonly height: number },
  ): Promise<DrawnScreen>;
  /** How long the app has to say it is ready. */
  readonly timeoutMs: number;
  /** How long the whole draw has, from its start. The capture has whatever the load left of it. */
  readonly budgetMs: number;
}

/** The name of a screen, as a refusal says it. */
export const SCREEN_LABEL: Readonly<Record<ScreenName, string>> = {
  [ScreenName.Factory]: 'The Factory',
  [ScreenName.Board]: 'The Board',
  [ScreenName.Inbox]: 'The Inbox',
  [ScreenName.Task]: "The task's drawer",
  [ScreenName.Plan]: 'Plan',
};

/**
 * Why nothing is drawn while the window is out of sight. Closing it only hides it (spec §3), and a hidden
 * WebKit page runs no animation frame, which a capture waits on.
 */
export const WINDOW_HIDDEN =
  "10db's window is hidden, closed or minimised, so it can't draw a screen. Ask the builder to bring 10db forward and try again.";

/** What the frame's app posts to its parent when it has drawn, or cannot. */
export type FrameMessage =
  | { readonly source: 'tendb-screen'; readonly kind: 'ready' }
  | { readonly source: 'tendb-screen'; readonly kind: 'refused'; readonly reason: string };

function frameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const { source, kind, reason } = data as Record<string, unknown>;
  if (source !== 'tendb-screen') return null;
  if (kind === 'ready') return { source, kind };
  if (kind === 'refused' && typeof reason === 'string') return { source, kind, reason };
  return null;
}

const seconds = (ms: number): string => String(Math.round(ms / 100) / 10).replace(/\.0$/, '');

/**
 * Why a capture failed, in words. html-to-image rejects with the DOM `Event` of an image that would not
 * load (`img.onerror = reject`), which has no message and prints as `[object Event]`.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  if (typeof error === 'object' && error !== null) {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string' && message !== '') return message;
    if (typeof Event !== 'undefined' && error instanceof Event)
      return 'an image the screen shows could not be loaded into the drawing';
  }
  return 'the browser gave no reason';
}

/** Draws one screen: resolves with its picture, or the reason there is none. Never rejects. */
export function drawScreen(options: DrawOptions): Promise<DrawResult> {
  const { request, doc } = options;
  const label = SCREEN_LABEL[request.screen];
  const size = { width: request.width, height: request.height };

  const frame = doc.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('inert', '');
  frame.tabIndex = -1;
  frame.title = 'A screen being drawn for Plan';
  // Inside the window's viewport, behind everything and fully transparent: WebKit throttles the timers
  // and animation frames of a frame outside the viewport, which would hold a drawer's transition back.
  Object.assign(frame.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    zIndex: '-1',
    width: `${String(size.width)}px`,
    height: `${String(size.height)}px`,
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  });
  frame.src = frameUrl(options.origin, request, options.daemon);

  return new Promise<DrawResult>((resolve) => {
    const win = doc.defaultView;
    const startedAt = performance.now();
    let settled = false;
    let capturing = false;
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: DrawResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(captureTimer);
      win?.removeEventListener('message', onMessage);
      frame.remove();
      resolve(result);
    };
    const onMessage = (event: MessageEvent): void => {
      // Only the frame we made, from the app's own origin, is the screen speaking.
      if (event.source !== frame.contentWindow || event.origin !== options.origin) return;
      const message = frameMessage(event.data);
      if (message === null) return;
      if (message.kind === 'refused') {
        finish({ ok: false, reason: message.reason });
        return;
      }
      if (capturing) return;
      capturing = true;
      // The app has answered, so the load is over: the capture has what is left of the draw.
      clearTimeout(timer);
      const captureMs = Math.max(0, options.budgetMs - (performance.now() - startedAt));
      captureTimer = setTimeout(() => {
        finish({
          ok: false,
          reason:
            doc.visibilityState === 'visible'
              ? `${label} finished loading, but making it into a picture took longer than ${seconds(captureMs)} s, so it was not drawn.`
              : WINDOW_HIDDEN,
        });
      }, captureMs);
      options.capture(frame, size).then(
        (image) => {
          finish({ ok: true, image });
        },
        (error: unknown) => {
          finish({
            ok: false,
            reason: `${label} could not be made into a picture: ${messageOf(error)}`,
          });
        },
      );
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        reason:
          doc.visibilityState === 'visible'
            ? `${label} did not finish loading in ${seconds(options.timeoutMs)} s, so it was not drawn.`
            : WINDOW_HIDDEN,
      });
    }, options.timeoutMs);
    win?.addEventListener('message', onMessage);
    doc.body.append(frame);
  });
}
