import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';

const project = projectDto({
  areas: [{ name: 'repo', globs: ['**'] }],
  hazards: [
    {
      name: 'deps',
      globs: ['**/package.json'],
      commands: ['pnpm add', 'make backend-lock'],
    },
  ],
});

const assessment = {
  additions: [
    {
      id: 'a1',
      hazard: 'deps',
      kind: 'command',
      value: 'make backend-lock',
      reason: 'Updates the backend lockfile.',
      evidence: { file: 'Makefile', line: 6 },
      addedAt: '2026-11-08T10:00:00.000Z',
    },
    {
      id: 'a2',
      hazard: 'deps',
      kind: 'glob',
      value: 'amps/backend/uv.lock',
      reason: 'The backend lockfile.',
      evidence: { file: 'amps/backend/uv.lock' },
      addedAt: '2026-11-08T10:00:00.000Z',
    },
  ],
  assessedAt: '2026-11-08T10:00:00.000Z',
  commit: 'abc',
  pendingRemovals: 0,
};

function serve(extra: Parameters<typeof server.use> = []) {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/hazard-assessment'), () =>
      HttpResponse.json(assessment),
    ),
    ...extra,
    ...baseHandlers(),
  );
}

describe('what 10db added to the hazards', () => {
  it('says in plain words what was added, why and where it was found', async () => {
    serve();
    renderApp('/settings/areas');
    expect(
      await screen.findByText(
        /Added the command make backend-lock to "deps": Updates the backend lockfile\./,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Found in Makefile, line 6/)).toBeTruthy();
    expect(
      screen.getByText(/Added the path pattern amps\/backend\/uv\.lock to "deps"/),
    ).toBeTruthy();
    expect(screen.getByText(/Found in amps\/backend\/uv\.lock/)).toBeTruthy();
  });

  it('undoes one addition', async () => {
    const undone: string[] = [];
    serve([
      http.delete(
        daemonUrl('/projects/:projectId/hazard-assessment/additions/:additionId'),
        ({ params }) => {
          undone.push(String(params['additionId']));
          return HttpResponse.json({ ...assessment, additions: assessment.additions.slice(1) });
        },
      ),
    ]);
    renderApp('/settings/areas');
    fireEvent.click(await screen.findByRole('button', { name: 'Undo make backend-lock' }));
    await waitFor(() => {
      expect(undone).toEqual(['a1']);
    });
  });

  it('looks again, says how many it added and that removals wait in the Inbox', async () => {
    serve([
      http.post(daemonUrl('/projects/:projectId/hazard-assessment/look-again'), () =>
        HttpResponse.json({
          ok: true,
          added: 2,
          assessment: { ...assessment, pendingRemovals: 1 },
        }),
      ),
    ]);
    renderApp('/settings/areas');
    fireEvent.click(await screen.findByRole('button', { name: 'Look again' }));
    expect(await screen.findByText(/Added 2 things/)).toBeTruthy();
    expect(screen.getByText(/1 change is waiting in the Inbox for your yes/)).toBeTruthy();
  });

  it('says nothing changed when the model could not answer', async () => {
    serve([
      http.post(daemonUrl('/projects/:projectId/hazard-assessment/look-again'), () =>
        HttpResponse.json({
          ok: false,
          message: 'The model was not available in time, so nothing changed.',
        }),
      ),
    ]);
    renderApp('/settings/areas');
    fireEvent.click(await screen.findByRole('button', { name: 'Look again' }));
    expect(await screen.findByText(/so nothing changed/)).toBeTruthy();
  });
});
