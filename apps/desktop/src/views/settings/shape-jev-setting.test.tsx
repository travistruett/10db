import { ShapeJevSettingDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountDto } from '../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { judgeStatusDto, serveJudge } from '../../test/judge-fixtures';
import { SHAPE_JEV_LABEL } from './shape-jev-setting';

// Shape spec §9: a project's opt-in, off by default, names where the messages go.

const ROUTER = accountDto({ kind: 'openrouter', label: 'Work key', secretSet: true });

function servePlanning(judgeAccount: typeof ROUTER | null) {
  serveJudge({
    status: judgeStatusDto({
      config: { ...judgeStatusDto().config, accountId: judgeAccount?.id ?? null },
      account:
        judgeAccount === null
          ? null
          : {
              id: judgeAccount.id,
              label: judgeAccount.label,
              secretSet: true,
              secretState: 'set',
            },
    }),
  });
}

describe('Settings › Planning › Send brainstorm messages to fast models', () => {
  it.each([
    { name: 'off', enabled: false, disabled: true },
    { name: 'on, so it can always be turned off', enabled: true, disabled: false },
  ])(
    'with no account for decisions and the switch $name, links to where one is picked',
    async ({ enabled, disabled }) => {
      servePlanning(null);
      server.use(
        http.get(daemonUrl('/projects/:projectId/shape-jev'), () => HttpResponse.json({ enabled })),
        ...baseHandlers(),
      );
      renderApp('/settings/planning');
      const toggle = await screen.findByRole('switch', { name: SHAPE_JEV_LABEL });
      expect(await screen.findByText('Pick an account for decisions first.')).toBeTruthy();
      // The setting is loaded once the switch shows it; only the missing account can hold it off.
      await waitFor(() => {
        expect(toggle).toHaveProperty('checked', enabled);
      });
      await waitFor(() => {
        expect(toggle).toHaveProperty('disabled', disabled);
      });
      const link = screen.getByRole('link', { name: 'Open Decisions' });
      expect(link.getAttribute('href')).toBe('/settings/decisions?focus=runs-on');
    },
  );

  it('is off by default, names the account decisions run on, and sends the change', async () => {
    servePlanning(ROUTER);
    const put: unknown[] = [];
    server.use(
      http.put(daemonUrl('/projects/:projectId/shape-jev'), async ({ request }) => {
        const body = ShapeJevSettingDto.parse(await request.json());
        put.push(body);
        return HttpResponse.json(body);
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/planning');
    const toggle = await screen.findByRole('switch', { name: SHAPE_JEV_LABEL });
    await waitFor(() => {
      expect(toggle).toHaveProperty('disabled', false);
    });
    expect(toggle).toHaveProperty('checked', false);
    expect(
      screen.getByText(
        /Sends your brainstorm messages, not code, to the account decisions run on \(OpenRouter · Work key\)/,
      ),
    ).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(put).toEqual([{ enabled: true }]);
    });
    await waitFor(() => {
      expect(toggle).toHaveProperty('checked', true);
    });
  });
});
