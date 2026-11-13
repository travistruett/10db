import {
  JudgeKind,
  mintId,
  TRUST_DEFAULTS,
  TrustSwitches,
  type TrustSettingsDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { TRUST_ROWS } from './trust-rows';

// Trust spec §9: Settings › Trust switches what comes along into each session, app-wide.

function serve(initial: Omit<TrustSettingsDto, 'judges'> & Partial<TrustSettingsDto>) {
  let settings: TrustSettingsDto = { judges: [], ...initial };
  const put: TrustSwitches[] = [];
  server.use(
    http.get(daemonUrl('/settings/trust'), () => HttpResponse.json(settings)),
    http.put(daemonUrl('/settings/trust'), async ({ request }) => {
      const switches = TrustSwitches.parse(await request.json());
      put.push(switches);
      settings = {
        ...settings,
        switches,
        plugins: settings.plugins.map((p) => ({
          ...p,
          on: switches.yourPlugins && (switches.plugins[p.id] ?? p.enabledInClaude),
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

  it('keeps both of two quick changes, each sent on what the daemon last saved', async () => {
    const { put } = serve({ switches: TRUST_DEFAULTS, plugins: [] });
    renderApp('/settings/trust');
    const web = await screen.findByRole('switch', { name: 'Web' });
    await waitFor(() => {
      expect(web).toHaveProperty('disabled', false);
    });
    fireEvent.click(web);
    fireEvent.click(screen.getByRole('switch', { name: 'Your skills' }));
    await waitFor(() => {
      expect(put).toHaveLength(2);
    });
    expect(put[1]).toEqual({ ...TRUST_DEFAULTS, web: false, yourSkills: false });
  });

  it('puts a plugin the builder switched back to following Claude Code', async () => {
    const { put } = serve({
      switches: { ...TRUST_DEFAULTS, plugins: { 'p@m': true } },
      plugins: [{ id: 'p@m', name: 'p', version: '1.2.0', enabledInClaude: false, on: true }],
    });
    renderApp('/settings/trust');
    fireEvent.click(await screen.findByRole('button', { name: 'Follow Claude Code: p@m' }));
    await waitFor(() => {
      expect(put).toEqual([TRUST_DEFAULTS]);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'p@m' })).toHaveProperty('checked', false);
    });
    expect(screen.getByText('Off in Claude Code')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Follow Claude Code: p@m' })).toBeNull();
  });

  it('shows every plugin off, and unswitchable, while Your plugins is off', async () => {
    serve({
      switches: { ...TRUST_DEFAULTS, yourPlugins: false },
      plugins: [{ id: 'p@m', name: 'p', version: '1.2.0', enabledInClaude: true, on: false }],
    });
    renderApp('/settings/trust');
    const toggle = await screen.findByRole('switch', { name: 'p@m' });
    expect(toggle).toHaveProperty('checked', false);
    expect(toggle).toHaveProperty('disabled', true);
  });

  it("shows each account's judge, and why a rules account has no judge", async () => {
    serve({
      switches: TRUST_DEFAULTS,
      plugins: [],
      judges: [
        {
          accountId: DEFAULT_ACCOUNT.id,
          label: 'Claude plan',
          model: 'claude-opus-5-5',
          judge: JudgeKind.Native,
          why: null,
        },
        {
          accountId: mintId('Account'),
          label: 'Gateway',
          model: null,
          judge: JudgeKind.Rules,
          why: "Auto mode doesn't run through a gateway account yet.",
        },
      ],
    });
    renderApp('/settings/trust');
    const list = await screen.findByRole('region', { name: 'Judge' });
    const plan = await within(list).findByRole('listitem', { name: 'Claude plan' });
    expect(within(plan).getByText('claude-opus-5-5')).toBeTruthy();
    expect(within(plan).getByText("Claude Code's auto mode")).toBeTruthy();
    expect(
      within(plan).getByText(
        "On a model auto mode doesn't run, a session falls back to 10db's rules and says so in its thread.",
      ),
    ).toBeTruthy();
    const rules = within(list).getByRole('listitem', { name: 'Gateway' });
    expect(within(rules).getByText('No model offered')).toBeTruthy();
    expect(within(rules).getByText("10db's rules: a card where they can't decide")).toBeTruthy();
    expect(
      within(rules).getByText("Auto mode doesn't run through a gateway account yet."),
    ).toBeTruthy();
  });

  it("shows the daemon's refusal when the read is refused", async () => {
    server.use(
      http.get(daemonUrl('/settings/trust'), () =>
        HttpResponse.json(
          { error: 'forbidden', message: 'The dev UI reads only: act in the 10db app' },
          { status: 403 },
        ),
      ),
      ...baseHandlers(),
    );
    renderApp('/settings/trust');
    expect(await screen.findByText('The dev UI reads only: act in the 10db app')).toBeTruthy();
  });
});
