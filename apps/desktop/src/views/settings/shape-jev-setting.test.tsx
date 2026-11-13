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
  it('is disabled until an account runs decisions, and links to where one is picked', async () => {
    servePlanning(null);
    server.use(
      // On, so the switch showing it means the setting has loaded and only the missing account holds it off.
      http.get(daemonUrl('/projects/:projectId/shape-jev'), () =>
        HttpResponse.json({ enabled: true }),
      ),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    renderApp('/settings/planning');
    const toggle = await screen.findByRole('switch', { name: SHAPE_JEV_LABEL });
    await waitFor(() => {
      expect(toggle).toHaveProperty('checked', true);
    });
    expect(toggle).toHaveProperty('disabled', true);
    expect(await screen.findByText('Pick an account for decisions first')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Decisions' });
    expect(link.getAttribute('href')).toBe('/settings/decisions?focus=runs-on');
  });

  it('is off by default, names the account decisions run on, and sends the change', async () => {
    servePlanning(ROUTER);
    const put: unknown[] = [];
    server.use(
      http.put(daemonUrl('/projects/:projectId/shape-jev'), async ({ request }) => {
        const body = ShapeJevSettingDto.parse(await request.json());
        put.push(body);
        return HttpResponse.json(body);
      }),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
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
