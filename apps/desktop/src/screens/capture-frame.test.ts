import { SCREEN_IMAGE_MAX_BYTES } from '@10db/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureFrame, type Drawing } from './capture-frame';

// Shape spec §5.5: the loaded frame becomes an image no larger than a conversation keeps, and a picture
// of nothing is no picture. That real canvases hold what this reads is in e2e/see-screen.spec.ts.

const size = { width: 900, height: 700 };
const dataUrl = (type: string, bytes: number): string =>
  `data:${type};base64,${Buffer.alloc(bytes, 1).toString('base64')}`;

function loadedFrame(): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  return frame;
}

interface Painted {
  /** RGBA, one pixel after another. */
  readonly pixels?: readonly number[];
  readonly png?: string;
  readonly jpeg?: string;
}

const TWO_COLOURS = [10, 20, 30, 255, 200, 210, 220, 255];

/** A canvas holding `pixels`, with the encoders' answers. jsdom has no canvas of its own. */
function canvas({ pixels = TWO_COLOURS, png, jpeg }: Painted): HTMLCanvasElement {
  const data = new Uint8ClampedArray(pixels);
  return {
    width: size.width,
    height: size.height,
    getContext: () => ({
      getImageData: () => ({ data }),
    }),
    toDataURL: (type: string) => (type === 'image/jpeg' ? jpeg : png) ?? 'data:,',
  } as unknown as HTMLCanvasElement;
}

const toCanvas = vi.fn<Drawing['toCanvas']>();
const drawing: Drawing = { toCanvas };
beforeEach(() => {
  toCanvas.mockReset();
});

describe('captureFrame', () => {
  it('draws the frame’s document once, at the size asked for, at one pixel to a pixel', async () => {
    toCanvas.mockResolvedValue(canvas({ png: dataUrl('image/png', 100) }));
    const frame = loadedFrame();
    const image = await captureFrame(frame, size, drawing);
    expect(toCanvas).toHaveBeenCalledTimes(1);
    expect(toCanvas).toHaveBeenCalledWith(
      frame.contentDocument?.documentElement,
      expect.objectContaining({ width: 900, height: 700, pixelRatio: 1 }),
    );
    expect(image).toEqual({
      mediaType: 'image/png',
      data: Buffer.alloc(100, 1).toString('base64'),
      width: 900,
      height: 700,
    });
  });

  it('keeps a PNG that is too big as a JPEG of the same drawing, which text on a screen survives', async () => {
    const painted = canvas({
      png: dataUrl('image/png', SCREEN_IMAGE_MAX_BYTES + 1),
      jpeg: dataUrl('image/jpeg', 5000),
    });
    const encode = vi.spyOn(painted, 'toDataURL');
    toCanvas.mockResolvedValue(painted);
    const image = await captureFrame(loadedFrame(), size, drawing);
    expect(image.mediaType).toBe('image/jpeg');
    expect(encode).toHaveBeenCalledWith('image/jpeg', 0.85);
    expect(toCanvas).toHaveBeenCalledTimes(1);
  });

  it('fails, saying so, when even the JPEG is too big', async () => {
    toCanvas.mockResolvedValue(
      canvas({
        png: dataUrl('image/png', SCREEN_IMAGE_MAX_BYTES + 1),
        jpeg: dataUrl('image/jpeg', SCREEN_IMAGE_MAX_BYTES + 1),
      }),
    );
    await expect(captureFrame(loadedFrame(), size, drawing)).rejects.toThrow(/too large/);
  });

  it('fails when the frame holds no document of ours to read', async () => {
    const frame = document.createElement('iframe');
    await expect(captureFrame(frame, size, drawing)).rejects.toThrow(/no document/);
  });

  it('fails, rather than hand over an empty image, when the drawing comes back empty', async () => {
    toCanvas.mockResolvedValue(canvas({ png: 'data:,' }));
    await expect(captureFrame(loadedFrame(), size, drawing)).rejects.toThrow(/empty/);
  });

  it('fails, saying so, when the drawing came out one flat colour', async () => {
    const flat = [18, 18, 18, 255, 18, 18, 18, 255, 18, 18, 18, 255];
    toCanvas.mockResolvedValue(canvas({ pixels: flat, png: dataUrl('image/png', 100) }));
    await expect(captureFrame(loadedFrame(), size, drawing)).rejects.toThrow(/one colour/);
  });

  it('fails, saying so, when the canvas cannot be read back', async () => {
    const painted = canvas({ png: dataUrl('image/png', 100) });
    vi.spyOn(painted, 'getContext').mockReturnValue(null);
    toCanvas.mockResolvedValue(painted);
    await expect(captureFrame(loadedFrame(), size, drawing)).rejects.toThrow(/could not be read/);
  });
});
