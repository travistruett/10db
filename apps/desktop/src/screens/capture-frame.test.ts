import { SCREEN_IMAGE_MAX_BYTES } from '@10db/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureFrame, type Drawing } from './capture-frame';

// Shape spec §5.5: the loaded frame becomes an image no larger than a conversation keeps.

const size = { width: 900, height: 700 };
const dataUrl = (type: string, bytes: number): string =>
  `data:${type};base64,${Buffer.alloc(bytes, 1).toString('base64')}`;

function loadedFrame(): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  return frame;
}

const toPng = vi.fn<Drawing['toPng']>();
const toJpeg = vi.fn<Drawing['toJpeg']>();
const drawing: Drawing = { toPng, toJpeg };
beforeEach(() => {
  toPng.mockReset();
  toJpeg.mockReset();
});

describe('captureFrame', () => {
  it('draws the frame’s document at the size asked for, at one pixel to a pixel', async () => {
    toPng.mockResolvedValue(dataUrl('image/png', 100));
    const frame = loadedFrame();
    const image = await captureFrame(frame, size, drawing);
    expect(toPng).toHaveBeenCalledWith(
      frame.contentDocument?.documentElement,
      expect.objectContaining({ width: 900, height: 700, pixelRatio: 1 }),
    );
    expect(image).toEqual({
      mediaType: 'image/png',
      data: Buffer.alloc(100, 1).toString('base64'),
      width: 900,
      height: 700,
    });
    expect(toJpeg).not.toHaveBeenCalled();
  });

  it('keeps a PNG that is too big as a JPEG, which text on a screen survives', async () => {
    toPng.mockResolvedValue(dataUrl('image/png', SCREEN_IMAGE_MAX_BYTES + 1));
    toJpeg.mockResolvedValue(dataUrl('image/jpeg', 5000));
    const image = await captureFrame(loadedFrame(), size, drawing);
    expect(image.mediaType).toBe('image/jpeg');
    expect(toJpeg).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quality: 0.85, width: 900, height: 700, pixelRatio: 1 }),
    );
  });

  it('fails, saying so, when even the JPEG is too big', async () => {
    toPng.mockResolvedValue(dataUrl('image/png', SCREEN_IMAGE_MAX_BYTES + 1));
    toJpeg.mockResolvedValue(dataUrl('image/jpeg', SCREEN_IMAGE_MAX_BYTES + 1));
    await expect(captureFrame(loadedFrame(), size, drawing)).rejects.toThrow(/too large/);
  });

  it('fails when the frame holds no document of ours to read', async () => {
    const frame = document.createElement('iframe');
    await expect(captureFrame(frame, size, drawing)).rejects.toThrow(/no document/);
  });

  it('fails, rather than hand over an empty image, when the drawing comes back empty', async () => {
    toPng.mockResolvedValue('data:,');
    await expect(captureFrame(loadedFrame(), size, drawing)).rejects.toThrow(/empty/);
  });
});
