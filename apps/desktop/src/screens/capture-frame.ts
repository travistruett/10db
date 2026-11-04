import { SCREEN_IMAGE_MAX_BYTES, ScreenMediaType } from '@10db/contracts';
import { toCanvas } from 'html-to-image';
import type { DrawnScreen } from './draw-screen';

// Shape spec §5.5. The loaded frame becomes an image. This is a drawing of the frame's own document
// (its DOM and styles serialised into an SVG, then painted to a canvas), so it needs no screen-recording
// permission and shows only the frame, never what else is on the builder's screen. One drawing makes
// both encodings, and a drawing that came out one flat colour is no picture of a screen.

const JPEG_QUALITY = 0.85;
/** How a base64 string's length relates to the bytes it holds. */
const decodedBytes = (base64: string): number => Math.floor((base64.length * 3) / 4);

function encoded(canvas: HTMLCanvasElement, type: string, quality?: number): string {
  const match = /^data:[^;,]+;base64,(.+)$/.exec(canvas.toDataURL(type, quality));
  if (match?.[1] === undefined) throw new Error('the drawing came back empty');
  return match[1];
}

function isOneColour(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('the drawing could not be read back');
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = new Uint32Array(data.buffer, data.byteOffset, Math.floor(data.length / 4));
  return pixels.every((pixel) => pixel === pixels[0]);
}

/** What draws a document to a canvas: html-to-image; a test hands in its own. */
export interface Drawing {
  readonly toCanvas: typeof toCanvas;
}

/** The frame as a PNG, or as a JPEG when the PNG is too big to keep; throws when it has no picture. */
export async function captureFrame(
  frame: HTMLIFrameElement,
  size: { readonly width: number; readonly height: number },
  drawing: Drawing = { toCanvas },
): Promise<DrawnScreen> {
  const root = frame.contentDocument?.documentElement;
  if (root === undefined) throw new Error('the frame holds no document to draw');
  const canvas = await drawing.toCanvas(root, { ...size, pixelRatio: 1, cacheBust: false });
  if (isOneColour(canvas)) throw new Error('the drawing came out one colour, so it shows nothing');

  const png = encoded(canvas, ScreenMediaType.Png);
  if (decodedBytes(png) <= SCREEN_IMAGE_MAX_BYTES)
    return { mediaType: ScreenMediaType.Png, data: png, ...size };

  const jpeg = encoded(canvas, ScreenMediaType.Jpeg, JPEG_QUALITY);
  if (decodedBytes(jpeg) > SCREEN_IMAGE_MAX_BYTES)
    throw new Error('the picture is too large to keep, even as a JPEG');
  return { mediaType: ScreenMediaType.Jpeg, data: jpeg, ...size };
}
