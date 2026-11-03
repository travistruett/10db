import { OneWayPathsDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { ONE_WAY_PATHS_LABEL } from './one-way-paths-setting';

// Shape spec §7: the globs that force a spec, edited one per line in Settings › General.

describe('Settings › General › One-way paths', () => {
  it('shows the saved globs one per line and sends the edited list', async () => {
    const put: unknown[] = [];
    server.use(
      http.get(daemonUrl('/projects/:projectId/one-way-paths'), () =>
        HttpResponse.json({ paths: ['packages/db/drizzle/**', 'packages/contracts/src/**'] }),
      ),
      http.put(daemonUrl('/projects/:projectId/one-way-paths'), async ({ request }) => {
        const body = OneWayPathsDto.parse(await request.json());
        put.push(body);
        return HttpResponse.json(body);
      }),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/settings/general');
    const box = await screen.findByRole('textbox', { name: ONE_WAY_PATHS_LABEL });
    await waitFor(() => {
      expect(box).toHaveProperty('value', 'packages/db/drizzle/**\npackages/contracts/src/**');
    });
    const save = screen.getByRole('button', { name: 'Save one-way paths' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(box, { target: { value: 'packages/db/drizzle/**\n\n  infra/**  \n' } });
    fireEvent.click(save);
    await waitFor(() => {
      expect(put).toEqual([{ paths: ['packages/db/drizzle/**', 'infra/**'] }]);
    });
  });
});
