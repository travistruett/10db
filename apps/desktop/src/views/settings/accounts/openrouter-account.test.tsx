import { AccountId } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountDto, accountUsageDto, DEFAULT_ACCOUNT } from '../../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';
import { projectDto } from '../../../test/fixtures';
import { judgeStatusDto, serveJudge } from '../../../test/judge-fixtures';

const DECISIONS = accountDto({ kind: 'openrouter', label: 'OpenRouter', secretSet: true });
const SPARE = accountDto({ kind: 'openrouter', label: 'Spare', secretSet: false });
const PROJECT = projectDto({
  name: 'Renewals',
  accountId: DEFAULT_ACCOUNT.id,
  fallbackAccountId: null,
});

function serve(opts: { test?: unknown } = {}) {
  const tested: string[] = [];
  serveJudge({
    status: judgeStatusDto({
      config: { ...judgeStatusDto().config, accountId: DECISIONS.id },
      account: { id: DECISIONS.id, label: 'OpenRouter', secretSet: true, secretState: 'set' },
    }),
    accounts: [DECISIONS, SPARE],
  });
  server.use(
    http.get(daemonUrl('/accounts'), () => HttpResponse.json([DEFAULT_ACCOUNT, DECISIONS, SPARE])),
    http.get(daemonUrl('/projects'), () => HttpResponse.json([PROJECT])),
    http.get(daemonUrl('/accounts/:accountId/usage'), ({ params }) => {
      const id = AccountId.parse(params['accountId']);
      return HttpResponse.json(
        accountUsageDto({
          accountId: id,
          total: {
            tokensIn: 0,
            tokensOut: 0,
            tokensCached: 0,
            costUsd: id === DECISIONS.id ? 0.5 : null,
          },
        }),
      );
    }),
    http.post(daemonUrl('/accounts/:accountId/test'), ({ params }) => {
      tested.push(String(params['accountId']));
      return HttpResponse.json(
        opts.test ?? { ok: true, model: 'typesafe/jev-1.13', latencyMs: 340, costUsd: 0.0001 },
      );
    }),
    ...baseHandlers(),
  );
  return { tested };
}

describe('an OpenRouter account in Accounts', () => {
  it('says what uses it, that it runs no agent, and its month in dollars or a dash', async () => {
    serve();
    renderApp('/settings/accounts');
    const decisions = await screen.findByRole('button', { name: 'Open OpenRouter' });
    const decisionsRow = decisions.closest('tr');
    const spareRow = screen.getByRole('button', { name: 'Open Spare' }).closest('tr');
    if (!decisionsRow || !spareRow) throw new Error('rows not found');
    expect(
      within(decisionsRow).getByText("Used by: decisions · Can't run agents yet"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(within(decisionsRow).getByText('$0.50')).toBeTruthy();
    });
    expect(within(spareRow).getByText("Used by nothing · Can't run agents yet")).toBeTruthy();
    await waitFor(() => {
      expect(within(spareRow).getByText('—')).toBeTruthy();
    });
    const plan = screen.getByRole('button', { name: 'Open Claude plan' }).closest('tr');
    if (!plan) throw new Error('row not found');
    // The status is a dot and words like Overview's, not a pill.
    expect(within(plan).getByTestId('connection-dot').getAttribute('data-color')).toBe('teal');
    expect(within(plan).getByText('Ready')).toBeTruthy();
    expect(within(spareRow).getByTestId('connection-dot').getAttribute('data-color')).toBe(
      'yellow',
    );
    expect(within(spareRow).getByText('Needs a secret')).toBeTruthy();
    expect(within(plan).getByText("Used by: Renewals' agents")).toBeTruthy();
  });

  it.each([
    { label: 'Claude plan', glyph: 'tabler-icon-user-circle' },
    { label: 'Work key', glyph: 'tabler-icon-key' },
    { label: 'Client codex', glyph: 'tabler-icon-brand-openai' },
    { label: 'Client aws', glyph: 'tabler-icon-brand-aws' },
  ])('marks the $label row with its provider', async ({ label, glyph }) => {
    serve();
    server.use(
      http.get(daemonUrl('/accounts'), () =>
        HttpResponse.json([
          DEFAULT_ACCOUNT,
          accountDto({ kind: 'openrouter', label: 'Work key' }),
          accountDto({ kind: 'codex_signin', label: 'Client codex', expectedIdentity: 'a@b.c' }),
          accountDto({
            kind: 'bedrock',
            label: 'Client aws',
            settings: { region: 'us-west-2', awsProfile: 'p' },
          }),
        ]),
      ),
    );
    renderApp('/settings/accounts');
    const row = (await screen.findByRole('button', { name: `Open ${label}` })).closest('tr');
    expect(row?.querySelector(`.${glyph}`)).not.toBeNull();
  });

  it('opens its drawer from ?focus=<id>, with Test and none of an agent account’s controls', async () => {
    const { tested } = serve();
    renderApp(`/settings/accounts?focus=${DECISIONS.id}`);
    const drawer = await screen.findByRole('dialog', { name: 'OpenRouter' });
    expect(within(drawer).getByText('Used by: decisions')).toBeTruthy();
    expect(within(drawer).getByText("Can't run agents yet")).toBeTruthy();
    expect(within(drawer).queryByRole('heading', { name: 'Identity' })).toBeNull();
    expect(within(drawer).queryByRole('textbox', { name: 'Lane cap' })).toBeNull();
    expect(within(drawer).queryByText(/Model by tier|Pause/)).toBeNull();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Test' }));
    expect(await within(drawer).findByText('Works · 340 ms · $0.0001')).toBeTruthy();
    expect(tested).toEqual([DECISIONS.id]);
  });

  it('shows OpenRouter’s refusal beside Test', async () => {
    serve({ test: { ok: false, error: 'OpenRouter refused the key' } });
    renderApp(`/settings/accounts?focus=${DECISIONS.id}`);
    const drawer = await screen.findByRole('dialog', { name: 'OpenRouter' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Test' }));
    expect(await within(drawer).findByText('OpenRouter refused the key')).toBeTruthy();
  });

  it('keeps Test off until the account has a key', async () => {
    serve();
    renderApp(`/settings/accounts?focus=${SPARE.id}`);
    const drawer = await screen.findByRole('dialog', { name: 'Spare' });
    const test = within(drawer).getByRole('button', { name: 'Test' });
    expect((test as HTMLButtonElement).disabled).toBe(true);
  });
});
