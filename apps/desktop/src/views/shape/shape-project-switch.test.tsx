import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { shapeDto, shapeMessageDto, shapeViewDto } from '../../test/shape-fixtures';

// Shape is per project: switching project must not leave the old project's conversation on screen.

const alpha = projectViewDto({ name: 'alpha', repoPath: '/Users/x/a' });
const beta = projectViewDto({ name: 'beta', repoPath: '/Users/x/b' });

/** jsdom never finishes the dropdown's transition, so its content stays `display: none` once open. */
const HIDDEN = { hidden: true } as const;

describe('Shape: switching project', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('leaves another project’s open conversation for /shape of the new project', async () => {
    const base = shapeDto({ projectId: alpha.id, state: 'proposed', round: 1 });
    const view = shapeViewDto({ shape: base, messages: [shapeMessageDto(base.id)] });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([alpha, beta])),
      http.get(daemonUrl('/projects/:projectId/shapes'), ({ params }) =>
        HttpResponse.json(params['projectId'] === alpha.id ? [base] : []),
      ),
      http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
      ...baseHandlers(),
      eventStream.addEventListener('connection', () => undefined),
    );
    const { router } = renderApp(`/shape/${base.id}`);
    const trigger = await screen.findByRole('button', { name: 'Project: alpha. Switch project' });
    await screen.findByRole('textbox', { name: 'Message' });
    expect(router.state.location.pathname).toBe(`/shape/${base.id}`);

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: /beta/, ...HIDDEN }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/shape');
    });
    expect(
      await screen.findByRole('button', { name: 'Project: beta. Switch project' }),
    ).toBeTruthy();
  });

  it('still leaves for /shape of the new project when the switch came before the conversation loaded', async () => {
    const base = shapeDto({ projectId: alpha.id, state: 'proposed', round: 1 });
    const view = shapeViewDto({ shape: base, messages: [shapeMessageDto(base.id)] });
    let release: () => void = () => undefined;
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([alpha, beta])),
      http.get(daemonUrl('/projects/:projectId/shapes'), ({ params }) =>
        HttpResponse.json(params['projectId'] === alpha.id ? [base] : []),
      ),
      http.get(daemonUrl('/shapes/:shapeId'), async () => {
        await loaded;
        return HttpResponse.json(view);
      }),
      ...baseHandlers(),
      eventStream.addEventListener('connection', () => undefined),
    );
    const { router } = renderApp(`/shape/${base.id}`);
    const trigger = await screen.findByRole('button', { name: 'Project: alpha. Switch project' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: /beta/, ...HIDDEN }));
    await screen.findByRole('button', { name: 'Project: beta. Switch project' });
    // The conversation has not arrived, so nothing can be compared with the new project yet.
    expect(router.state.location.pathname).toBe(`/shape/${base.id}`);

    release();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/shape');
    });
  });

  it('never posts a send in the new project to the conversation a failed send made in the old one', async () => {
    const alphaShape = shapeDto({ projectId: alpha.id, state: 'listening', round: 0 });
    const betaShape = shapeDto({ projectId: beta.id, state: 'listening', round: 0 });
    const createdFor: string[] = [];
    const posted: string[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([alpha, beta])),
      http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([])),
      http.post(daemonUrl('/projects/:projectId/shapes'), ({ params }) => {
        const projectId = String(params['projectId']);
        createdFor.push(projectId);
        return HttpResponse.json(projectId === alpha.id ? alphaShape : betaShape, {
          status: 201,
        });
      }),
      http.post(daemonUrl('/shapes/:shapeId/messages'), ({ params }) => {
        const shapeId = String(params['shapeId']);
        posted.push(shapeId);
        if (posted.length === 1) {
          return HttpResponse.json(
            { error: 'unavailable', message: 'Claude is away' },
            { status: 503 },
          );
        }
        return HttpResponse.json(shapeMessageDto(betaShape.id), { status: 202 });
      }),
      http.get(daemonUrl('/shapes/:shapeId'), ({ params }) =>
        HttpResponse.json(
          shapeViewDto({ shape: params['shapeId'] === alphaShape.id ? alphaShape : betaShape }),
        ),
      ),
      ...baseHandlers(),
      eventStream.addEventListener('connection', () => undefined),
    );
    const { router } = renderApp('/shape');
    const trigger = await screen.findByRole('button', { name: 'Project: alpha. Switch project' });
    const input = await screen.findByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'Move density ahead of the scrollbars.' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(await screen.findByText('Claude is away')).toBeTruthy();

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: /beta/, ...HIDDEN }));
    await screen.findByRole('button', { name: 'Project: beta. Switch project' });
    expect(router.state.location.pathname).toBe('/shape');

    const again = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(again, { target: { value: 'Something for beta.' } });
    fireEvent.keyDown(again, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(posted).toHaveLength(2);
    });
    expect(createdFor).toEqual([alpha.id, beta.id]);
    expect(posted).toEqual([alphaShape.id, betaShape.id]);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/shape/${betaShape.id}`);
    });
  });
});
