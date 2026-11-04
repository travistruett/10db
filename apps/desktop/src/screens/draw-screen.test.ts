import { mintId, type ScreenRenderRequest } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawScreen, WINDOW_HIDDEN, type DrawnScreen } from './draw-screen';

// Shape spec §5.5: the window draws a screen in a hidden frame of itself and either has a picture or
// says why not. The frame is the one thing that runs the app for a session, so it is boxed in.

const ORIGIN = window.location.origin;
const request: ScreenRenderRequest = {
  id: 'req-1',
  screen: 'board',
  projectId: mintId('Project'),
  shapeId: mintId('Shape'),
  width: 900,
  height: 700,
  token: 'render-token',
};
const picture: DrawnScreen = { mediaType: 'image/png', data: 'AAAA', width: 900, height: 700 };

const frames = (): HTMLIFrameElement[] => [...document.querySelectorAll('iframe')];
const frame = (): HTMLIFrameElement => {
  const [only] = frames();
  if (only === undefined) throw new Error('no frame');
  return only;
};
/** What the frame's app posts to its parent. */
function say(data: unknown, from: MessageEventSource | null = frame().contentWindow): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: ORIGIN, source: from }));
}
const ready = { source: 'tendb-screen', kind: 'ready' };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  for (const f of frames()) f.remove();
});

/** A capture that fails with something that is not an Error, as html-to-image's `img.onerror = reject` does. */
const failWith = (reason: unknown): Promise<never> =>
  new Promise((_resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    reject(reason);
  });

const draw = (capture: () => Promise<DrawnScreen> = () => Promise.resolve(picture)) =>
  drawScreen({
    request,
    daemon: 'http://127.0.0.1:4999',
    origin: ORIGIN,
    doc: document,
    capture,
    timeoutMs: 15_000,
    budgetMs: 19_000,
  });

describe('the frame', () => {
  it('is the app at the render address, the size asked for, out of sight and out of reach', () => {
    void draw();
    const f = frame();
    expect(f.src).toMatch(new RegExp(`^${ORIGIN}/\\?render=render-token&`));
    expect(f.getAttribute('aria-hidden')).toBe('true');
    expect(f.tabIndex).toBe(-1);
    expect(f.hasAttribute('inert')).toBe(true);
    expect(f.style.width).toBe('900px');
    expect(f.style.height).toBe('700px');
    expect(f.style.pointerEvents).toBe('none');
  });

  it('sits behind the window, unseen, not outside it, where WebKit would throttle a frame', () => {
    void draw();
    const f = frame();
    expect(f.style.left).toBe('0px');
    expect(f.style.top).toBe('0px');
    expect(f.style.zIndex).toBe('-1');
    expect(f.style.opacity).toBe('0');
  });

  it('runs scripts of its own origin and nothing more: no form, popup or top navigation', () => {
    void draw();
    const sandbox = frame().getAttribute('sandbox')?.split(/\s+/).sort();
    expect(sandbox).toEqual(['allow-same-origin', 'allow-scripts']);
  });

  it('is gone once it has answered, however it answered', async () => {
    const drawing = draw();
    say(ready);
    await drawing;
    expect(frames()).toEqual([]);
  });
});

describe('drawing a screen', () => {
  it('captures the frame at the size asked for once the app says it is ready', async () => {
    const capture = vi.fn(() => Promise.resolve(picture));
    const drawing = draw(capture);
    expect(capture).not.toHaveBeenCalled();
    say(ready);
    await expect(drawing).resolves.toEqual({ ok: true, image: picture });
    expect(capture).toHaveBeenCalledWith(expect.anything(), { width: 900, height: 700 });
  });

  it('refuses with the reason the app gave when it could not draw', async () => {
    const drawing = draw();
    say({ source: 'tendb-screen', kind: 'refused', reason: 'The Board failed to load: HTTP 500' });
    await expect(drawing).resolves.toEqual({
      ok: false,
      reason: 'The Board failed to load: HTTP 500',
    });
  });

  it('listens to the frame alone: a message from anywhere else is not the screen', async () => {
    const capture = vi.fn(() => Promise.resolve(picture));
    const drawing = draw(capture);
    say(ready, window);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: ready,
        origin: 'http://evil.test',
        source: frame().contentWindow,
      }),
    );
    say({ kind: 'ready' });
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(drawing).resolves.toMatchObject({ ok: false });
  });

  it('refuses, saying how long it waited, when the app never says it is ready', async () => {
    const drawing = draw();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(drawing).resolves.toEqual({
      ok: false,
      reason: 'The Board did not finish loading in 15 s, so it was not drawn.',
    });
    expect(frames()).toEqual([]);
  });

  it('says the window was hidden, not that the screen was slow, when it was hidden while drawing', async () => {
    const drawing = draw(() => new Promise(() => undefined));
    say(ready);
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      await vi.advanceTimersByTimeAsync(19_000);
      expect(await drawing).toEqual({ ok: false, reason: WINDOW_HIDDEN });
    } finally {
      hidden.mockRestore();
    }
  });

  it('refuses, with why, when the capture fails', async () => {
    const drawing = draw(() => Promise.reject(new Error('the canvas is tainted')));
    say(ready);
    await expect(drawing).resolves.toEqual({
      ok: false,
      reason: 'The Board could not be made into a picture: the canvas is tainted',
    });
    expect(frames()).toEqual([]);
  });

  it('names a readable cause when the capture rejects with a DOM event, as html-to-image does for an image', async () => {
    const drawing = draw(() => failWith(new Event('error')));
    say(ready);
    const result = await drawing;
    expect(result.ok).toBe(false);
    const reason = !result.ok ? result.reason : '';
    expect(reason).not.toContain('[object');
    expect(reason).toMatch(/^The Board could not be made into a picture: .*image/);
  });

  it('names the message of an error event, and of any object that carries one', async () => {
    const reasonOf = async (cause: unknown): Promise<string> => {
      const drawing = draw(() => failWith(cause));
      say(ready);
      const result = await drawing;
      return result.ok ? '' : result.reason;
    };
    expect(await reasonOf(new ErrorEvent('error', { message: 'font failed' }))).toContain(
      'font failed',
    );
    expect(await reasonOf({ message: 'no canvas' })).toContain('no canvas');
    expect(await reasonOf({})).not.toContain('[object');
  });

  it('tells a slow capture from a slow load', async () => {
    const drawing = draw(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(5_000);
    say(ready);
    expect(frames()).toHaveLength(1);
    // The load timer no longer runs: the app had said it was ready.
    await vi.advanceTimersByTimeAsync(13_999);
    expect(frames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await drawing;
    expect(result.ok).toBe(false);
    const reason = !result.ok ? result.reason : '';
    expect(reason).toBe(
      'The Board finished loading, but making it into a picture took longer than 14 s, so it was not drawn.',
    );
    expect(reason).not.toContain('finish loading');
    expect(frames()).toEqual([]);
  });

  it('gives a capture what the load left of the draw, however late the app was ready', async () => {
    const drawing = draw(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(14_500);
    say(ready);
    await vi.advanceTimersByTimeAsync(4_499);
    expect(frames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(drawing).resolves.toEqual({
      ok: false,
      reason:
        'The Board finished loading, but making it into a picture took longer than 4.5 s, so it was not drawn.',
    });
  });

  it('draws a screen that loads quickly and takes a long time to capture', async () => {
    const drawing = draw(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(picture);
          }, 17_000);
        }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    say(ready);
    await vi.advanceTimersByTimeAsync(17_000);
    await expect(drawing).resolves.toEqual({ ok: true, image: picture });
  });

  it('names the task’s drawer and Plan for what they are', async () => {
    const drawing = drawScreen({
      request: { ...request, screen: 'task', taskId: mintId('Task') },
      daemon: 'http://127.0.0.1:4999',
      origin: ORIGIN,
      doc: document,
      capture: () => Promise.resolve(picture),
      timeoutMs: 1000,
      budgetMs: 2000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await drawing;
    expect(!result.ok && result.reason).toContain(
      "The task's drawer did not finish loading in 1 s",
    );
  });
});
