import { SCREEN_IMAGE_MAX_BYTES, ScreenMediaType } from '@10db/contracts';
import { toJpeg, toPng } from 'html-to-image';
import type { DrawnScreen } from './draw-screen';

// Shape spec §5.5. The loaded frame becomes an image. This is a drawing of the frame's own document
// (its DOM and styles serialised into an SVG, then painted to a canvas), so it needs no screen-recording
// permission and shows only the frame, never what else is on the builder's screen.

const JPEG_QUALITY = 0.85;
/** How a base64 string's length relates to the bytes it holds. */
const decodedBytes = (base64: string): number => Math.floor((base64.length * 3) / 4);

function split(url: string): { type: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url);
  return match?.[1] === undefined || match[2] === undefined
    ? null
    : { type: match[1], data: match[2] };
}

/** What draws a document to an image: html-to-image's two encoders; a test hands in its own. */
export interface Drawing {
  readonly toPng: typeof toPng;
  readonly toJpeg: typeof toJpeg;
}

/** The frame as a PNG, or as a JPEG when the PNG is too big to keep; throws when neither fits. */
export async function captureFrame(
  frame: HTMLIFrameElement,
  size: { readonly width: number; readonly height: number },
  drawing: Drawing = { toPng, toJpeg },
): Promise<DrawnScreen> {
  const root = frame.contentDocument?.documentElement;
  if (root === undefined) throw new Error('the frame holds no document to draw');
  const options = { width: size.width, height: size.height, pixelRatio: 1, cacheBust: false };

  const png = split(await drawing.toPng(root, options));
  if (png === null) throw new Error('the drawing came back empty');
  if (decodedBytes(png.data) <= SCREEN_IMAGE_MAX_BYTES)
    return { mediaType: ScreenMediaType.Png, data: png.data, ...size };

  const jpeg = split(await drawing.toJpeg(root, { ...options, quality: JPEG_QUALITY }));
  if (jpeg === null) throw new Error('the drawing came back empty');
  if (decodedBytes(jpeg.data) > SCREEN_IMAGE_MAX_BYTES)
    throw new Error('the picture is too large to keep, even as a JPEG');
  return { mediaType: ScreenMediaType.Jpeg, data: jpeg.data, ...size };
}
