import type { AccountDto, AccountUsageDto } from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountDto, accountUsageDto, DEFAULT_ACCOUNT } from '../../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';

function serve(accounts: AccountDto[], usage: Record<string, AccountUsageDto> = {}) {
  server.use(
    http.get(daemonUrl('/accounts'), () => HttpResponse.json(accounts)),
    http.get(daemonUrl('/accounts/:accountId/usage'), ({ params }) =>
      HttpResponse.json(
        usage[String(params['accountId'])] ??
          accountUsageDto({ accountId: accounts[0]?.id ?? DEFAULT_ACCOUNT.id }),
      ),
    ),
    ...baseHandlers(),
  );
  renderApp('/settings/accounts');
}

async function rowOf(label: string) {
  const table = await screen.findByRole('table', { name: 'Accounts' });
  const row = (await within(table).findByRole('button', { name: `Open ${label}` })).closest('tr');
  if (!row) throw new Error(`no row for ${label}`);
  return row;
}

describe('AccountsSection', () => {
  it('lists the default account with its identity, status and token usage', async () => {
    serve([DEFAULT_ACCOUNT]);
    const row = await rowOf('Claude plan');
    expect(within(row).getByText('builder@example.com')).toBeTruthy();
    expect(within(row).getByText('Default')).toBeTruthy();
    expect(within(row).getByText('Claude subscription')).toBeTruthy();
    expect(within(row).getByText('Ready')).toBeTruthy();
    expect(await within(row).findByText('2K tokens')).toBeTruthy();
    expect(within(row).queryByText(/\$/)).toBeNull();
  });

  it.each([
    {
      name: 'an unconfirmed subscription',
      account: accountDto({ label: 'Fresh login' }),
      status: 'Needs sign-in',
      identity: 'No identity yet',
    },
    {
      name: 'an API key without a secret',
      account: accountDto({ label: 'Client key', kind: 'anthropic_api_key' }),
      status: 'Needs a secret',
      identity: 'No identity yet',
    },
  ])('shows $status for $name', async ({ account, status, identity }) => {
    serve([DEFAULT_ACCOUNT, account]);
    const row = await rowOf(account.label);
    expect(within(row).getByText(status)).toBeTruthy();
    expect(within(row).getByText(identity)).toBeTruthy();
  });

  it('shows a metered account’s spend against its cap with a progress bar', async () => {
    const metered = accountDto({
      label: 'Metered key',
      kind: 'anthropic_api_key',
      secretSet: true,
      monthlyCapUsd: 500,
    });
    serve([DEFAULT_ACCOUNT, metered], {
      [metered.id]: accountUsageDto({
        accountId: metered.id,
        total: { tokensIn: 10, tokensOut: 5, tokensCached: 0, costUsd: 120 },
        monthlyCapUsd: 500,
      }),
    });
    const row = await rowOf('Metered key');
    expect(await within(row).findByText('$120.00 of $500.00')).toBeTruthy();
    expect(within(row).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('24');
  });

  it('keeps the bar full and flags a spend past the cap', async () => {
    const metered = accountDto({
      label: 'Over key',
      kind: 'anthropic_api_key',
      secretSet: true,
      monthlyCapUsd: 100,
    });
    serve([DEFAULT_ACCOUNT, metered], {
      [metered.id]: accountUsageDto({
        accountId: metered.id,
        total: { tokensIn: 10, tokensOut: 5, tokensCached: 0, costUsd: 150 },
        monthlyCapUsd: 100,
      }),
    });
    const row = await rowOf('Over key');
    expect(await within(row).findByText('$150.00 of $100.00')).toBeTruthy();
    expect(within(row).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('puts an archived account only under Archived (1), with its label and kind', async () => {
    const archived = accountDto({ label: 'Old client', kind: 'gateway', archived: true });
    serve([DEFAULT_ACCOUNT, archived]);
    const table = await screen.findByRole('table', { name: 'Accounts' });
    expect(within(table).queryByText('Old client')).toBeNull();
    const toggle = await screen.findByRole('button', { name: 'Archived (1)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(await screen.findByText('Old client')).toBeTruthy();
    expect(screen.getByText('Gateway')).toBeTruthy();
  });

  it('offers Add account above the table', async () => {
    serve([DEFAULT_ACCOUNT]);
    expect(await screen.findByRole('button', { name: 'Add account' })).toBeTruthy();
  });
});
