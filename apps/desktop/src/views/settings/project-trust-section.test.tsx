import {
  effectiveTrust,
  TRUST_DEFAULTS,
  TrustOverrides,
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

function serve(preview: SetupPreviewDto, overrides: TrustOverrides = {}) {
  let current: ProjectTrustDto = {
    overrides,
    effective: effectiveTrust(TRUST_DEFAULTS, overrides),
    preview,
  };
  const put: TrustOverrides[] = [];
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/settings/trust'), () =>
      HttpResponse.json({
        switches: TRUST_DEFAULTS,
        plugins: [{ id: 'p@m', name: 'p', version: '1.2.0', enabledInClaude: true, on: true }],
      }),
    ),
    http.get(daemonUrl('/projects/:projectId/trust'), () => HttpResponse.json(current)),
    http.put(daemonUrl('/projects/:projectId/trust'), async ({ request }) => {
      const next = TrustOverrides.parse(await request.json());
      put.push(next);
      current = { overrides: next, effective: effectiveTrust(TRUST_DEFAULTS, next), preview };
      return HttpResponse.json(current);
    }),
    ...baseHandlers(),
  );
  return { put };
}

const NOTHING: SetupPreviewDto = { skills: [], plugins: [], leftOut: [] };

describe('Settings › project Trust', () => {
  it('As app clears the override; Off sends web: false', async () => {
    const { put } = serve(NOTHING, { yourSkills: false });
    renderApp('/settings/project-trust');
    const web = await screen.findByRole('radiogroup', { name: 'Web' });
    const skills = screen.getByRole('radiogroup', { name: 'Your skills' });
    // The project's own switches have loaded: its override shows.
    await waitFor(() => {
      expect(within(skills).getByLabelText('Off')).toHaveProperty('checked', true);
    });
    expect(within(web).getByLabelText('As app')).toHaveProperty('checked', true);
    fireEvent.click(within(web).getByLabelText('Off'));
    await waitFor(() => {
      expect(put).toEqual([{ yourSkills: false, web: false }]);
    });
    fireEvent.click(within(skills).getByLabelText('As app'));
    await waitFor(() => {
      expect(put.at(-1)).toEqual({ web: false });
    });
  });

  it('switches a plugin for the project alone', async () => {
    const { put } = serve(NOTHING);
    renderApp('/settings/project-trust');
    const plugin = await screen.findByRole('radiogroup', { name: 'p@m' });
    await waitFor(() => {
      expect(within(plugin).getByLabelText('Off')).toHaveProperty('disabled', false);
    });
    fireEvent.click(within(plugin).getByLabelText('Off'));
    await waitFor(() => {
      expect(put).toEqual([{ plugins: { 'p@m': false } }]);
    });
  });

  it('lists what comes along and what was left out, with reasons', async () => {
    serve({
      skills: ['careful', 'project:release'],
      plugins: ['p@m'],
      leftOut: [
        { what: '~/.claude/skills/lane', why: 'it lies in, or holds, a folder a lane can write' },
      ],
    });
    renderApp('/settings/project-trust');
    const list = await screen.findByRole('region', { name: 'Comes along' });
    expect(await within(list).findByText('careful')).toBeTruthy();
    expect(within(list).getByText('project:release')).toBeTruthy();
    expect(within(list).getByText('p@m')).toBeTruthy();
    expect(within(list).getByText('~/.claude/skills/lane')).toBeTruthy();
    expect(within(list).getByText('it lies in, or holds, a folder a lane can write')).toBeTruthy();
  });

  it("shows the daemon's refusal when the read is refused", async () => {
    serve(NOTHING);
    server.use(
      http.get(daemonUrl('/projects/:projectId/trust'), () =>
        HttpResponse.json(
          { error: 'forbidden', message: 'The dev UI reads only: act in the 10db app' },
          { status: 403 },
        ),
      ),
    );
    renderApp('/settings/project-trust');
    expect(await screen.findByText('The dev UI reads only: act in the 10db app')).toBeTruthy();
  });
});
