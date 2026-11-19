import { AccountId } from '@10db/contracts';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountUsageDto, DEFAULT_ACCOUNT } from '../../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';

describe('AccountsSection', () => {
  it('lists the default account with its identity, status and token usage', async () => {
    server.use(
      http.get(daemonUrl('/accounts'), () => HttpResponse.json([DEFAULT_ACCOUNT])),
      http.get(daemonUrl('/accounts/pauses'), () => HttpResponse.json([])),
      http.get(daemonUrl('/accounts/:accountId/usage'), ({ params }) =>
        HttpResponse.json(accountUsageDto({ accountId: AccountId.parse(params['accountId']) })),
      ),
      ...baseHandlers(),
    );
    renderApp('/settings/accounts');
    const table = await screen.findByRole('table', { name: 'Accounts' });
    const row = (await within(table).findByRole('button', { name: 'Open Claude plan' })).closest(
      'tr',
    );
    if (!row) throw new Error('no row for Claude plan');
    expect(within(row).getByText('builder@example.com')).toBeTruthy();
    expect(within(row).getByText('Default')).toBeTruthy();
    expect(within(row).getByText('Claude subscription')).toBeTruthy();
    expect(within(row).getByText('Ready')).toBeTruthy();
    expect(await within(row).findByText('2K tokens')).toBeTruthy();
    expect(within(row).queryByText(/\$/)).toBeNull();
  });
});
