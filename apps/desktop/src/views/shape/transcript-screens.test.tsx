import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { shapeDto, shapeMessageDto, shapeViewDto } from '../../test/shape-fixtures';

// Shape spec §5.5: a screenshot Plan took shows in the conversation, so the builder sees what Plan saw.

const project = projectViewDto();
const base = shapeDto({ projectId: project.id });
const body = JSON.stringify({
  screen: 'board',
  width: 1200,
  height: 900,
  name: '0001.png',
  mediaType: 'image/png',
});
const view = shapeViewDto({
  shape: base,
  messages: [
    shapeMessageDto(base.id, { author: 'builder', body: 'What does the board look like?' }),
    shapeMessageDto(base.id, {
      author: 'claude',
      kind: 'tool',
      body: 'see_screen · board · 1200×900',
    }),
    shapeMessageDto(base.id, { author: 'claude', kind: 'screen', body }),
    shapeMessageDto(base.id, { author: 'claude', body: 'The board has four columns.' }),
  ],
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
let authorization: string | null;
beforeEach(() => {
  authorization = null;
});

function serve(png: () => Response): void {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([base])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
    http.get(daemonUrl('/shapes/:shapeId/screens/:name'), ({ request }) => {
      authorization = request.headers.get('authorization');
      return png();
    }),
    ...baseHandlers(),
  );
}

describe('a screenshot in the conversation', () => {
  it('shows as an image in its place, read with the UI token and drawn from a data URL the window’s CSP allows', async () => {
    serve(() => new HttpResponse(PNG, { headers: { 'content-type': 'image/png' } }));
    renderApp(`/shape/${base.id}`);
    const image = await screen.findByRole('img', { name: /The Board at 1200×900/ });
    expect(image.getAttribute('src')).toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    );
    expect(authorization).toBe('Bearer test-token');
    // It sits between the line that took it and what Claude said of it.
    const text = document.body.textContent;
    expect(text.indexOf('see_screen · board')).toBeLessThan(
      text.indexOf('The board has four columns'),
    );
  });

  it('says so, in words, when the picture can no longer be read', async () => {
    serve(() => HttpResponse.json({ error: 'not_found' }, { status: 404 }));
    renderApp(`/shape/${base.id}`);
    expect(await screen.findByText(/screenshot of the Board can no longer be shown/i)).toBeTruthy();
    expect(screen.queryByRole('img', { name: /The Board/ })).toBeNull();
  });

  it('leaves a screen row it does not understand out, rather than break the conversation', async () => {
    const broken = shapeViewDto({
      shape: base,
      messages: [shapeMessageDto(base.id, { author: 'claude', kind: 'screen', body: 'not json' })],
    });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([base])),
      http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(broken)),
      ...baseHandlers(),
    );
    renderApp(`/shape/${base.id}`);
    expect(await screen.findByRole('group', { name: 'Messages' })).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
