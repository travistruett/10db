import type { AccountDto } from '@10db/contracts';
import { AccountCreatedDto, AccountId, AccountInput } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  accountDto,
  accountSignInDto,
  accountUsageDto,
  DEFAULT_ACCOUNT,
} from '../../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';
import { judgeStatusDto, serveJudge } from '../../../test/judge-fixtures';

function serve(): unknown[] {
  const posts: unknown[] = [];
  const live: AccountDto[] = [DEFAULT_ACCOUNT];
  serveJudge({
    status: judgeStatusDto({
      config: { ...judgeStatusDto().config, accountId: null },
      account: null,
    }),
    accounts: live,
  });
  server.use(
    http.get(daemonUrl('/accounts'), () => HttpResponse.json(live)),
    http.post(daemonUrl('/accounts'), async ({ request }) => {
      const body: unknown = await request.json();
      posts.push(body);
      const input = AccountInput.parse(body);
      const account = accountDto({
        kind: input.kind,
        label: input.label,
        settings: 'settings' in input ? input.settings : {},
      });
      live.push(account);
      return HttpResponse.json(
        AccountCreatedDto.parse({
          account,
          signIn:
            input.kind === 'claude_subscription'
              ? accountSignInDto({ accountId: account.id })
              : null,
        }),
        { status: 201 },
      );
    }),
    http.get(daemonUrl('/accounts/:accountId/usage'), ({ params }) =>
      HttpResponse.json(accountUsageDto({ accountId: AccountId.parse(params['accountId']) })),
    ),
    http.get(daemonUrl('/accounts/:accountId/signin'), ({ params }) =>
      HttpResponse.json(accountSignInDto({ accountId: AccountId.parse(params['accountId']) })),
    ),
    ...baseHandlers(),
  );
  renderApp('/settings/accounts');
  return posts;
}

describe('AddAccountModal', () => {
  it('adds a subscription and opens its sign-in steps', async () => {
    const posts = serve();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Account' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Kind' }));
    fireEvent.click(
      await screen.findByRole('option', { name: 'Claude subscription', hidden: true }),
    );
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Label' }), {
      target: { value: 'Company A' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const drawer = await screen.findByRole('dialog', { name: /Company A/ });
    fireEvent.click(
      await within(drawer).findByRole('button', { name: 'Sign in from Terminal instead' }),
    );
    expect(await within(drawer).findByText('1. In Terminal, run')).toBeTruthy();
    expect(posts).toEqual([
      { kind: 'claude_subscription', label: 'Company A', payer: '', laneCap: 4, settings: {} },
    ]);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add Account' })).toBeNull();
    });
  });
});
