import { mintId, ScreenRefusalInput, type ScreenRenderRequest } from '@10db/contracts';
import { waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../test/daemon';
import { WINDOW_HIDDEN, type DrawResult } from './draw-screen';
import { ScreenRenderHost } from './screen-render-host';

// Shape spec §5.5: the window asks the daemon for screens to draw, draws each and answers.

const request: ScreenRenderRequest = {
  id: 'req-1',
  screen: 'board',
  projectId: mintId('Project'),
  shapeId: mintId('Shape'),
  width: 900,
  height: 700,
  token: 'render-token',
};
const picture = { mediaType: 'image/png', data: 'AAAA', width: 900, height: 700 } as const;

/** The daemon: hands out `request` to the first ask and holds every later ask open, as it does with no work. */
function daemon(answers: { image?: unknown; refuse?: unknown } = {}): void {
  let asks = 0;
  server.use(
    http.post(daemonUrl('/screens/claim'), async () => {
      asks += 1;
      if (asks === 1) return HttpResponse.json(request);
      await delay('infinite');
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(daemonUrl('/screens/:requestId/image'), async ({ request: req, params }) => {
      answers.image = { id: params['requestId'], body: await req.json() };
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(daemonUrl('/screens/:requestId/refuse'), async ({ request: req, params }) => {
      answers.refuse = { id: params['requestId'], body: await req.json() };
      return new HttpResponse(null, { status: 204 });
    }),
    ...baseHandlers(),
  );
}

describe('the window’s screen host', () => {
  it('draws a screen the daemon asks for, at the daemon’s address, and answers with the picture', async () => {
    const answers: { image?: unknown } = {};
    daemon(answers);
    const draw = vi.fn((): Promise<DrawResult> => Promise.resolve({ ok: true, image: picture }));
    renderWithDaemon(<ScreenRenderHost draw={draw} />);
    await waitFor(() => {
      expect(answers.image).toEqual({ id: 'req-1', body: picture });
    });
    expect(draw).toHaveBeenCalledWith(request, 'http://127.0.0.1:4999');
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('answers with the reason when the screen could not be drawn', async () => {
    const answers: { refuse?: unknown } = {};
    daemon(answers);
    renderWithDaemon(
      <ScreenRenderHost
        draw={() => Promise.resolve({ ok: false, reason: 'The Board failed to load' })}
      />,
    );
    await waitFor(() => {
      expect(answers.refuse).toEqual({ id: 'req-1', body: { reason: 'The Board failed to load' } });
    });
  });

  it('cuts a reason the daemon would refuse for its length, so the session hears it at once', async () => {
    const answers: { refuse?: unknown } = {};
    daemon(answers);
    const long = 'The Board failed to load: ' + 'x'.repeat(2_000);
    renderWithDaemon(
      <ScreenRenderHost draw={() => Promise.resolve({ ok: false, reason: long })} />,
    );
    await waitFor(() => {
      expect(answers.refuse).toBeDefined();
    });
    const { body } = answers.refuse as { body: { reason: string } };
    expect(body.reason.length).toBeLessThanOrEqual(ScreenRefusalInput.shape.reason.maxLength ?? 0);
    expect(ScreenRefusalInput.safeParse(body).success).toBe(true);
    expect(body.reason.startsWith('The Board failed to load: xxx')).toBe(true);
    expect(body.reason.endsWith('…')).toBe(true);
  });

  it('says so, in a reason that fits, when the daemon turns a refusal away anyway', async () => {
    const refused: unknown[] = [];
    let asks = 0;
    server.use(
      http.post(daemonUrl('/screens/claim'), async () => {
        asks += 1;
        if (asks === 1) return HttpResponse.json(request);
        await delay('infinite');
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(daemonUrl('/screens/:requestId/refuse'), async ({ request: req }) => {
        refused.push(await req.json());
        return refused.length === 1
          ? HttpResponse.json({ error: 'bad_request' }, { status: 400 })
          : new HttpResponse(null, { status: 204 });
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(
      <ScreenRenderHost draw={() => Promise.resolve({ ok: false, reason: 'The Board broke' })} />,
    );
    await waitFor(() => {
      expect(refused).toHaveLength(2);
    });
    expect(refused[0]).toEqual({ reason: 'The Board broke' });
    expect(ScreenRefusalInput.safeParse(refused[1]).success).toBe(true);
  });

  it('refuses at once, drawing no frame, when the window is hidden, which pauses what a frame needs', async () => {
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      const answers: { refuse?: unknown } = {};
      daemon(answers);
      const draw = vi.fn((): Promise<DrawResult> => Promise.resolve({ ok: true, image: picture }));
      const started = Date.now();
      renderWithDaemon(<ScreenRenderHost draw={draw} />);
      await waitFor(() => {
        expect(answers.refuse).toEqual({ id: 'req-1', body: { reason: WINDOW_HIDDEN } });
      });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(draw).not.toHaveBeenCalled();
      expect(WINDOW_HIDDEN).toMatch(/bring 10db forward/i);
    } finally {
      hidden.mockRestore();
    }
  });

  it('asks again after an answer, so the next screen is drawn', async () => {
    const asked: string[] = [];
    server.use(
      http.post(daemonUrl('/screens/claim'), async () => {
        asked.push('claim');
        if (asked.length <= 2)
          return HttpResponse.json({ ...request, id: `req-${String(asked.length)}` });
        await delay('infinite');
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(
        daemonUrl('/screens/:requestId/image'),
        () => new HttpResponse(null, { status: 204 }),
      ),
      ...baseHandlers(),
    );
    const draw = vi.fn((): Promise<DrawResult> => Promise.resolve({ ok: true, image: picture }));
    renderWithDaemon(<ScreenRenderHost draw={draw} />);
    await waitFor(() => {
      expect(draw).toHaveBeenCalledTimes(2);
    });
  });
});
