import { ScreenName, type ScreenMediaType, type ScreenRenderRequest } from '@10db/contracts';
import { frameUrl } from './render-params';

// Shape spec §5.5. The window draws a screen for a session in a hidden frame of itself, and either has
// a picture or says why it has none. The frame runs the app under a render token; it is boxed in:
// sandboxed to scripts of its own origin, out of sight, out of focus and out of reach of the pointer.

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
}

/** The name of a screen, as a refusal says it. */
export const SCREEN_LABEL: Readonly<Record<ScreenName, string>> = {
  [ScreenName.Factory]: 'The Factory',
  [ScreenName.Board]: 'The Board',
  [ScreenName.Inbox]: 'The Inbox',
  [ScreenName.Task]: "The task's drawer",
  [ScreenName.Plan]: 'Plan',
};

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
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
  Object.assign(frame.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: `${String(size.width)}px`,
    height: `${String(size.height)}px`,
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  });
  frame.src = frameUrl(options.origin, request, options.daemon);

  return new Promise<DrawResult>((resolve) => {
    const win = doc.defaultView;
    let settled = false;
    const finish = (result: DrawResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
        reason: `${label} did not finish loading in ${seconds(options.timeoutMs)} s, so it was not drawn.`,
      });
    }, options.timeoutMs);
    win?.addEventListener('message', onMessage);
    doc.body.append(frame);
  });
}
