import { mintId, type ScreenRenderRequest } from '@10db/contracts';
import { waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../test/daemon';
import type { DrawResult } from './draw-screen';
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
