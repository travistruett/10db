import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScreenBroker, type ScreenBroker, type ScreenSpec } from './broker';

// Shape spec §5.5: the daemon asks the app's window to draw a screen and waits for the picture. The
// window asks for work by long-polling; nothing here touches the database.

const spec: ScreenSpec = {
  shapeId: mintId('Shape'),
  projectId: mintId('Project'),
  screen: 'board',
  width: 1200,
  height: 900,
};
const image = { mediaType: 'image/png', data: 'AAAA', width: 1200, height: 900 } as const;

let broker: ScreenBroker;
beforeEach(() => {
  vi.useFakeTimers();
  broker = createScreenBroker({ claimWaitMs: 1000, renderTimeoutMs: 5000, rendererFreshMs: 3000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a screen request', () => {
  it('is refused at once when no window has asked for work lately', async () => {
    const outcome = await broker.request(spec);
    expect(outcome).toMatchObject({ ok: false });
    expect(!outcome.ok && outcome.reason).toMatch(/window isn.t open/);
  });

  it('goes to a window that is waiting, with a token only that request holds', async () => {
    const claim = broker.claim();
    const pending = broker.request(spec);
    const request = await claim;
    expect(request).toMatchObject({
      screen: 'board',
      projectId: spec.projectId,
      shapeId: spec.shapeId,
      width: 1200,
      height: 900,
    });
    if (request === null) throw new Error('no request');
    expect(broker.tokenValid(request.token)).toBe(true);
    expect(broker.tokenValid('not-a-token')).toBe(false);
    expect(broker.deliver(request.id, image)).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true, image });
    // Its token dies with it.
    expect(broker.tokenValid(request.token)).toBe(false);
  });

  it('waits for the window’s next ask when it came between two', async () => {
    const first = broker.claim();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(first).resolves.toBeNull();
    const pending = broker.request(spec);
    const request = await broker.claim();
    expect(request).not.toBeNull();
    if (request !== null) broker.refuse(request.id, 'The Board is not drawn yet');
    await expect(pending).resolves.toEqual({ ok: false, reason: 'The Board is not drawn yet' });
  });

  it('is refused with the window’s own reason', async () => {
    const claim = broker.claim();
    const pending = broker.request(spec);
    const request = await claim;
    if (request === null) throw new Error('no request');
    broker.refuse(request.id, 'The Board failed to load');
    await expect(pending).resolves.toEqual({ ok: false, reason: 'The Board failed to load' });
  });

  it('is refused when the window never answers, and says how long it waited', async () => {
    const claim = broker.claim();
    const pending = broker.request(spec);
    await claim;
    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await pending;
    expect(!outcome.ok && outcome.reason).toMatch(/didn.t answer in 5 s/);
  });

  it('is answered once: a second answer for it is ignored', async () => {
    const claim = broker.claim();
    const pending = broker.request(spec);
    const request = await claim;
    if (request === null) throw new Error('no request');
    expect(broker.deliver(request.id, image)).toBe(true);
    expect(broker.deliver(request.id, image)).toBe(false);
    expect(broker.refuse(request.id, 'late')).toBe(false);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(broker.deliver('unknown', image)).toBe(false);
  });

  it('is refused when the window stops asking while it waits to be claimed', async () => {
    const claim = broker.claim();
    await vi.advanceTimersByTimeAsync(1000);
    await claim;
    const pending = broker.request(spec);
    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
  });

  it('gives each window one request: two windows never draw the same screen', async () => {
    const a = broker.claim();
    const b = broker.claim();
    const pending = broker.request(spec);
    const first = await a;
    expect(first).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(b).resolves.toBeNull();
    if (first) broker.deliver(first.id, image);
    await pending;
  });
});

describe('the window’s wait', () => {
  it('ends empty after the claim wait, so a closed window is noticed', async () => {
    const claim = broker.claim();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(claim).resolves.toBeNull();
  });

  it('ends empty when the window aborts it', async () => {
    const abort = new AbortController();
    const claim = broker.claim(abort.signal);
    abort.abort();
    await expect(claim).resolves.toBeNull();
  });
});
