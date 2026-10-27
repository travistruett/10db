import { AccountId, mintId, type AccountDto, type AccountUsageDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountDto,
  accountIdentityDto,
  accountSignInDto,
  accountUsageDto,
  DEFAULT_ACCOUNT,
} from '../../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';

interface Served {
  readonly patches: { id: string; body: unknown }[];
  identityCalls: string[];
}

function serve(
  accounts: AccountDto[],
  opts: {
    identity?: Record<string, ReturnType<typeof accountIdentityDto>>;
    identityStatus?: { status: number; message: string };
    usage?: Record<string, AccountUsageDto>;
  } = {},
): Served {
  const served: Served = { patches: [], identityCalls: [] };
  const live = [...accounts];
  server.use(
    http.get(daemonUrl('/accounts'), () => HttpResponse.json(live)),
    http.get(daemonUrl('/accounts/:accountId/usage'), ({ params }) =>
      HttpResponse.json(
        opts.usage?.[String(params['accountId'])] ??
          accountUsageDto({ accountId: AccountId.parse(params['accountId']) }),
      ),
    ),
    http.get(daemonUrl('/accounts/:accountId/signin'), ({ params }) =>
      HttpResponse.json(accountSignInDto({ accountId: AccountId.parse(params['accountId']) })),
    ),
    http.get(daemonUrl('/accounts/:accountId/identity'), ({ params }) => {
      const id = String(params['accountId']);
      served.identityCalls.push(id);
      if (opts.identityStatus)
        return HttpResponse.json(
          { message: opts.identityStatus.message },
          { status: opts.identityStatus.status },
        );
      return HttpResponse.json(opts.identity?.[id] ?? accountIdentityDto());
    }),
    http.patch(daemonUrl('/accounts/:accountId'), async ({ params, request }) => {
      const id = String(params['accountId']);
      const body = (await request.json()) as Record<string, unknown>;
      served.patches.push({ id, body });
      const index = live.findIndex((a) => a.id === id);
      const current = live[index];
      if (!current) return HttpResponse.json({ message: 'no such account' }, { status: 404 });
      const next = { ...current, ...body };
      live[index] = next;
      return HttpResponse.json(next);
    }),
    ...baseHandlers(),
  );
  renderApp('/settings/accounts');
  return served;
}

async function openDrawer(label: string) {
  const table = await screen.findByRole('table', { name: 'Accounts' });
  fireEvent.click(await within(table).findByRole('button', { name: `Open ${label}` }));
  return screen.findByRole('dialog', { name: (name) => name.startsWith(label) });
}

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

afterEach(() => {
  writeText.mockClear();
});

describe('AccountDrawer', () => {
  it('shows a subscription’s sign-in command and copies it', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    serve([DEFAULT_ACCOUNT, accountDto({ label: 'Fresh login' })]);
    const dialog = await openDrawer('Fresh login');
    expect(
      await within(dialog).findByText('CLAUDE_CONFIG_DIR=/data/accounts/a/claude claude'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy command' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('CLAUDE_CONFIG_DIR=/data/accounts/a/claude claude');
    });
    expect(await within(dialog).findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(within(dialog).getByText(/Sign in as the email this account should use/)).toBeTruthy();
  });

  it('says the default account’s login is the one 10db already uses', async () => {
    serve([DEFAULT_ACCOUNT]);
    const dialog = await openDrawer('Claude plan');
    expect(await within(dialog).findByText(/login 10db already uses/)).toBeTruthy();
  });

  it('does not ask for the identity until Check sign-in is clicked', async () => {
    const served = serve([DEFAULT_ACCOUNT, accountDto({ label: 'Fresh login' })]);
    const dialog = await openDrawer('Fresh login');
    await within(dialog).findByRole('button', { name: 'Check sign-in' });
    expect(served.identityCalls).toEqual([]);
  });

  it('confirms exactly the email the probe saw', async () => {
    const account = accountDto({ label: 'Fresh login' });
    const served = serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: 'client@example.com',
          refusal: {
            problem: 'unconfirmed',
            message: 'Fresh login has no identity recorded yet.',
            seenIdentity: 'client@example.com',
          },
        }),
      },
    });
    const dialog = await openDrawer('Fresh login');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(
      await within(dialog).findByText('Fresh login has no identity recorded yet.'),
    ).toBeTruthy();
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'Confirm client@example.com' }),
    );
    await waitFor(() => {
      expect(served.patches).toEqual([
        { id: account.id, body: { expectedIdentity: 'client@example.com' } },
      ]);
    });
    await waitFor(() => {
      expect(within(dialog).queryByRole('button', { name: /^Confirm / })).toBeNull();
    });
    expect(within(dialog).queryByText('Fresh login has no identity recorded yet.')).toBeNull();
    expect(await screen.findByText('client@example.com', { selector: 'code' })).toBeTruthy();
  });

  it('warns that a different recorded identity will be replaced', async () => {
    const account = accountDto({ label: 'Switched', expectedIdentity: 'old@example.com' });
    serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: 'new@example.com',
          refusal: {
            problem: 'identity_mismatch',
            message: 'Switched is signed in as a different login.',
            seenIdentity: 'new@example.com',
          },
        }),
      },
    });
    const dialog = await openDrawer('Switched');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(
      await within(dialog).findByText('Switched is signed in as a different login.'),
    ).toBeTruthy();
    expect(
      within(dialog).getByText('Sessions on this account will run as new@example.com from now on.'),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Confirm new@example.com' })).toBeTruthy();
  });

  it('shows a matching identity without offering Confirm', async () => {
    serve([DEFAULT_ACCOUNT]);
    const dialog = await openDrawer('Claude plan');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(await within(dialog).findByText('Signed in as builder@example.com')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Confirm / })).toBeNull();
  });

  it('offers Require for an API key that reports an organization', async () => {
    const account = accountDto({ label: 'Client key', kind: 'anthropic_api_key', secretSet: true });
    const served = serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: null,
          organization: 'Acme',
          subscription: false,
        }),
      },
    });
    const dialog = await openDrawer('Client key');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Require Acme' }));
    await waitFor(() => {
      expect(served.patches).toEqual([{ id: account.id, body: { expectedIdentity: 'Acme' } }]);
    });
  });

  it('shows a gateway’s organization but never offers Require', async () => {
    const account = accountDto({
      label: 'Router',
      kind: 'gateway',
      secretSet: true,
      settings: { baseUrl: 'https://gateway.example.com' },
    });
    serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({
          accountId: account.id,
          email: null,
          organization: 'Acme',
          subscription: false,
        }),
      },
    });
    const dialog = await openDrawer('Router');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check' }));
    expect(await within(dialog).findByText('Organization: Acme')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Require / })).toBeNull();
  });

  it('does not carry one account’s check over to another', async () => {
    const a = accountDto({ label: 'Account A' });
    const b = accountDto({ label: 'Account B', id: mintId('Account') });
    serve([DEFAULT_ACCOUNT, a, b], {
      identity: {
        [a.id]: accountIdentityDto({ accountId: a.id, email: 'a@example.com' }),
        [b.id]: accountIdentityDto({ accountId: b.id, email: 'b@example.com' }),
      },
    });
    const dialogA = await openDrawer('Account A');
    fireEvent.click(await within(dialogA).findByRole('button', { name: 'Check sign-in' }));
    expect(
      await within(dialogA).findByRole('button', { name: 'Confirm a@example.com' }),
    ).toBeTruthy();
    fireEvent.click(within(dialogA).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const dialogB = await openDrawer('Account B');
    await within(dialogB).findByRole('button', { name: 'Check sign-in' });
    expect(within(dialogB).queryByRole('button', { name: /^Confirm / })).toBeNull();
    expect(within(dialogB).queryByText(/a@example.com/)).toBeNull();
    fireEvent.click(within(dialogB).getByRole('button', { name: 'Check sign-in' }));
    expect(
      await within(dialogB).findByRole('button', { name: 'Confirm b@example.com' }),
    ).toBeTruthy();
  });

  it('shows the daemon’s message when the probe is refused', async () => {
    serve([DEFAULT_ACCOUNT, accountDto({ label: 'Busy' })], {
      identityStatus: { status: 409, message: 'Another sign-in check is already running.' },
    });
    const dialog = await openDrawer('Busy');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(
      await within(dialog).findByText('Another sign-in check is already running.'),
    ).toBeTruthy();
  });

  it('lists usage by project, with no dollar column for a subscription', async () => {
    const account = accountDto({ label: 'Fresh login' });
    serve([DEFAULT_ACCOUNT, account], {
      usage: {
        [account.id]: accountUsageDto({
          accountId: account.id,
          total: { tokensIn: 3000, tokensOut: 1500, tokensCached: 500, costUsd: null },
          byProject: [
            {
              projectId: mintId('Project'),
              projectName: 'Alpha',
              tokensIn: 2000,
              tokensOut: 1000,
              tokensCached: 300,
              costUsd: null,
            },
          ],
        }),
      },
    });
    const dialog = await openDrawer('Fresh login');
    const table = await within(dialog).findByRole('table', { name: 'Usage by project' });
    expect(within(dialog).getByText('October 2026')).toBeTruthy();
    expect(within(table).getByText('Alpha')).toBeTruthy();
    expect(within(table).getByText('2K')).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Cost' })).toBeNull();
    expect(within(table).queryByText(/\$/)).toBeNull();
  });

  it('shows dollars per project for a metered account and says when there are no sessions', async () => {
    const metered = accountDto({ label: 'Metered', kind: 'anthropic_api_key', secretSet: true });
    serve([DEFAULT_ACCOUNT, metered], {
      usage: {
        [metered.id]: accountUsageDto({
          accountId: metered.id,
          total: { tokensIn: 10, tokensOut: 5, tokensCached: 0, costUsd: 12.5 },
          byProject: [
            {
              projectId: mintId('Project'),
              projectName: 'Beta',
              tokensIn: 10,
              tokensOut: 5,
              tokensCached: 0,
              costUsd: 12.5,
            },
          ],
        }),
      },
    });
    const dialog = await openDrawer('Metered');
    const table = await within(dialog).findByRole('table', { name: 'Usage by project' });
    expect(within(table).getByRole('columnheader', { name: 'Cost' })).toBeTruthy();
    expect(within(table).getByText('$12.50')).toBeTruthy();
  });

  it('says there were no sessions when the month is empty', async () => {
    serve([DEFAULT_ACCOUNT]);
    const dialog = await openDrawer('Claude plan');
    expect(await within(dialog).findByText('No sessions this month')).toBeTruthy();
  });
});
