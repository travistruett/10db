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
});
