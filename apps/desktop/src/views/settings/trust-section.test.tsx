import { TRUST_DEFAULTS, TrustSwitches, type TrustSettingsDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { TRUST_ROWS } from './trust-rows';

// Trust spec §9: Settings › Trust switches what comes along into each session, app-wide.

function serve(initial: TrustSettingsDto) {
  let settings = initial;
  const put: TrustSwitches[] = [];
  server.use(
    http.get(daemonUrl('/settings/trust'), () => HttpResponse.json(settings)),
    http.put(daemonUrl('/settings/trust'), async ({ request }) => {
      const switches = TrustSwitches.parse(await request.json());
      put.push(switches);
      settings = {
        switches,
        plugins: settings.plugins.map((p) => ({
          ...p,
          on: switches.plugins[p.id] ?? p.enabledInClaude,
        })),
      };
      return HttpResponse.json(settings);
    }),
    ...baseHandlers(),
  );
  return { put };
}

describe('Settings › Trust', () => {
  it('shows every row on, with its per-provider note, and sends a change', async () => {
    const { put } = serve({ switches: TRUST_DEFAULTS, plugins: [] });
    renderApp('/settings/trust');
    for (const row of TRUST_ROWS) {
      const toggle = await screen.findByRole('switch', { name: row.label });
      await waitFor(() => {
        expect(toggle).toHaveProperty('disabled', false);
      });
      expect(toggle).toHaveProperty('checked', true);
      expect(screen.getByText(row.providers)).toBeTruthy();
      expect(row.description.endsWith('Applies from the next session.')).toBe(true);
    }
    fireEvent.click(screen.getByRole('switch', { name: 'Web' }));
    await waitFor(() => {
      expect(put).toEqual([{ ...TRUST_DEFAULTS, web: false }]);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Web' })).toHaveProperty('checked', false);
    });
  });

  it('lists a plugin off in Claude Code as off, and switches it', async () => {
    const { put } = serve({
      switches: TRUST_DEFAULTS,
      plugins: [{ id: 'p@m', name: 'p', version: '1.2.0', enabledInClaude: false, on: false }],
    });
    renderApp('/settings/trust');
    const toggle = await screen.findByRole('switch', { name: 'p@m' });
    expect(toggle).toHaveProperty('checked', false);
    expect(screen.getByText('1.2.0')).toBeTruthy();
    expect(screen.getByText('Off in Claude Code')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(put).toEqual([{ ...TRUST_DEFAULTS, plugins: { 'p@m': true } }]);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'p@m' })).toHaveProperty('checked', true);
    });
    expect(screen.queryByText('Off in Claude Code')).toBeNull();
  });
});
