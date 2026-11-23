import {
  effectiveTrust,
  mintId,
  type TrustGrantDto,
  TRUST_DEFAULTS,
  type ProjectTrustDto,
  type SetupPreviewDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';

// Trust spec §9: a project's Trust overrides each app-wide switch, and lists what comes along.

const project = projectDto();

const NOTHING: SetupPreviewDto = { skills: [], plugins: [], leftOut: [] };

function serve(initialGrants: readonly TrustGrantDto[]) {
  let grants = [...initialGrants];
  const removed: string[] = [];
  const current: ProjectTrustDto = {
    overrides: {},
    effective: effectiveTrust(TRUST_DEFAULTS, {}),
    preview: NOTHING,
  };
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/settings/trust'), () =>
      HttpResponse.json({
        switches: TRUST_DEFAULTS,
        plugins: [{ id: 'p@m', name: 'p', version: '1.2.0', enabledInClaude: true, on: true }],
        judges: [],
        tendbReady: false,
        mcpServers: [],
        mcpNotice: null,
      }),
    ),
    http.get(daemonUrl('/projects/:projectId/live-systems'), () =>
      HttpResponse.json({ liveSystems: [] }),
    ),
    http.get(daemonUrl('/projects/:projectId/trust-grants'), () => HttpResponse.json(grants)),
    http.delete(daemonUrl('/projects/:projectId/trust-grants/:grantId'), ({ params }) => {
      const id = String(params['grantId']);
      removed.push(id);
      grants = grants.filter((g) => g.id !== id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(daemonUrl('/projects/:projectId/trust'), () => HttpResponse.json(current)),
    ...baseHandlers(),
  );
  return { removed };
}

describe('Settings › project Trust', () => {
  it('lists a grant and removes it', async () => {
    const grant: TrustGrantDto = {
      id: mintId('TrustGrant'),
      projectId: project.id,
      limit: 'writes_live',
      target: 'deploys to staging with vercel',
      createdAt: '2026-11-14T10:00:00.000Z',
    };
    const { removed } = serve([grant]);
    renderApp('/settings/project-trust');
    const region = await screen.findByRole('region', { name: 'Allowed in This Project' });
    expect(await within(region).findByText('deploys to staging with vercel')).toBeTruthy();
    expect(within(region).getByText(/^Writing to Live Systems · /)).toBeTruthy();
    fireEvent.click(
      within(region).getByRole('button', { name: 'Remove deploys to staging with vercel' }),
    );
    await waitFor(() => {
      expect(removed).toEqual([grant.id]);
    });
    expect(await within(region).findByText('Nothing yet.')).toBeTruthy();
  });
});
