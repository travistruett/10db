import { TRUST_DEFAULTS, TrustSwitches, type TrustSettingsDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { TRUST_ROWS } from './trust-rows';

// Trust spec §9: Settings › Trust switches what comes along into each session, app-wide.

function serve() {
  let settings: TrustSettingsDto = {
    switches: TRUST_DEFAULTS,
    plugins: [],
    judges: [],
    tendbReady: false,
    mcpServers: [],
    mcpNotice: null,
  };
  const put: TrustSwitches[] = [];
  server.use(
    http.get(daemonUrl('/settings/trust'), () => HttpResponse.json(settings)),
    http.put(daemonUrl('/settings/trust'), async ({ request }) => {
      const switches = TrustSwitches.parse(await request.json());
      put.push(switches);
      settings = { ...settings, switches };
      return HttpResponse.json(settings);
    }),
    ...baseHandlers(),
  );
  return { put };
}

describe('Settings › Trust', () => {
  it('shows every row on, with its description, and sends a change', async () => {
    const { put } = serve();
    renderApp('/settings/trust');
    for (const row of TRUST_ROWS) {
      const toggle = await screen.findByRole('switch', { name: row.label });
      await waitFor(() => {
        expect(toggle).toHaveProperty('disabled', false);
      });
      expect(toggle).toHaveProperty('checked', true);
      expect(screen.getByText(row.description)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('switch', { name: 'Web' }));
    await waitFor(() => {
      expect(put).toEqual([{ ...TRUST_DEFAULTS, web: false }]);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Web' })).toHaveProperty('checked', false);
    });
  });
});
