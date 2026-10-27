import {
  AccountCreatedDto,
  AccountDto,
  AccountInput,
  type AccountId,
  type AccountPatch,
} from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  accountDto,
  accountIdentityDto,
  accountSignInDto,
  accountUsageDto,
  DEFAULT_ACCOUNT,
} from '../test/account-fixtures';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../test/daemon';
import {
  useAccountSignIn,
  useAccountUsage,
  useAccounts,
  useArchiveAccount,
  useCheckAccountIdentity,
  useCreateAccount,
  usePatchAccount,
} from './account-queries';
import { useProjects } from './queries';

/** Serves `/accounts` and `/projects` as empty lists and counts each fetch. */
function listCounts(): {
  readonly handlers: HttpHandler[];
  readonly counts: Record<string, number>;
} {
  const counts: Record<string, number> = { '/accounts': 0, '/projects': 0 };
  const serve = (path: string): HttpHandler =>
    http.get(daemonUrl(path), () => {
      counts[path] = (counts[path] ?? 0) + 1;
      return HttpResponse.json([]);
    });
  return { handlers: [serve('/accounts'), serve('/projects')], counts };
}

const NEW_ACCOUNT = AccountInput.parse({ kind: 'claude_subscription', label: 'Company B' });

function Listed() {
  useAccounts();
  useProjects();
  return null;
}

function Create() {
  const create = useCreateAccount();
  return (
    <button
      onClick={() => {
        create.mutate(NEW_ACCOUNT);
      }}
    >
      create
    </button>
  );
}

function Patch({ id }: { readonly id: AccountId }) {
  const patch = usePatchAccount(id);
  return (
    <button
      onClick={() => {
        patch.mutate({ label: 'Renamed' } satisfies AccountPatch);
      }}
    >
      patch
    </button>
  );
}

function Archive({ id }: { readonly id: AccountId }) {
  const archive = useArchiveAccount();
  return (
    <button
      onClick={() => {
        archive.mutate(id);
      }}
    >
      archive
    </button>
  );
}

function Usage({ id }: { readonly id: AccountId }) {
  const usage = useAccountUsage(id);
  return <p>{usage.data ? `tokens ${String(usage.data.total.tokensIn)}` : 'loading'}</p>;
}

function SignIn({ id }: { readonly id: AccountId }) {
  const [enabled, setEnabled] = useState(false);
  const signIn = useAccountSignIn(id, enabled);
  return (
    <>
      <button
        onClick={() => {
          setEnabled(true);
        }}
      >
        enable
      </button>
      <p>{signIn.data ? signIn.data.command : 'no command'}</p>
    </>
  );
}

function Identity({ id }: { readonly id: AccountId }) {
  const check = useCheckAccountIdentity();
  return (
    <>
      <button
        onClick={() => {
          check.mutate(id);
        }}
      >
        check
      </button>
      <p>{check.data ? (check.data.email ?? 'no email') : 'unchecked'}</p>
    </>
  );
}

describe('account hooks', () => {
  it('creates an account with the posted body and refetches the account list', async () => {
    const created = accountDto({ label: 'Company B' });
    let body: unknown;
    const { handlers, counts } = listCounts();
    server.use(
      ...handlers,
      http.post(daemonUrl('/accounts'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          AccountCreatedDto.parse({ account: created, signIn: accountSignInDto() }),
          { status: 201 },
        );
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(
      <>
        <Listed />
        <Create />
      </>,
    );
    await waitFor(() => {
      expect(counts['/accounts']).toBe(1);
    });
    fireEvent.click(screen.getByText('create'));
    await waitFor(() => {
      expect(counts['/accounts']).toBe(2);
    });
    expect(body).toEqual(NEW_ACCOUNT);
  });

  it('patches with only the patch and refetches accounts and projects', async () => {
    let body: unknown;
    const { handlers, counts } = listCounts();
    server.use(
      ...handlers,
      http.patch(daemonUrl(`/accounts/${DEFAULT_ACCOUNT.id}`), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(AccountDto.parse({ ...DEFAULT_ACCOUNT, label: 'Renamed' }));
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(
      <>
        <Listed />
        <Patch id={DEFAULT_ACCOUNT.id} />
      </>,
    );
    await waitFor(() => {
      expect(counts['/accounts']).toBe(1);
      expect(counts['/projects']).toBe(1);
    });
    fireEvent.click(screen.getByText('patch'));
    await waitFor(() => {
      expect(counts['/accounts']).toBe(2);
      expect(counts['/projects']).toBe(2);
    });
    expect(body).toEqual({ label: 'Renamed' });
  });

  it('archives by posting to the archive route and refetches the account list', async () => {
    let archived = 0;
    const { handlers, counts } = listCounts();
    server.use(
      ...handlers,
      http.post(daemonUrl(`/accounts/${DEFAULT_ACCOUNT.id}/archive`), () => {
        archived += 1;
        return HttpResponse.json(AccountDto.parse({ ...DEFAULT_ACCOUNT, archived: true }));
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(
      <>
        <Listed />
        <Archive id={DEFAULT_ACCOUNT.id} />
      </>,
    );
    await waitFor(() => {
      expect(counts['/accounts']).toBe(1);
    });
    fireEvent.click(screen.getByText('archive'));
    await waitFor(() => {
      expect(counts['/accounts']).toBe(2);
    });
    expect(archived).toBe(1);
  });

  it("requests an account's usage with no month query", async () => {
    const searches: string[] = [];
    server.use(
      http.get(daemonUrl(`/accounts/${DEFAULT_ACCOUNT.id}/usage`), ({ request }) => {
        searches.push(new URL(request.url).search);
        return HttpResponse.json(
          accountUsageDto({
            total: { tokensIn: 77, tokensOut: 1, tokensCached: 0, costUsd: null },
          }),
        );
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(<Usage id={DEFAULT_ACCOUNT.id} />);
    expect(await screen.findByText('tokens 77')).toBeTruthy();
    expect(searches).toEqual(['']);
  });

  it('requests the sign-in steps only when enabled', async () => {
    let requests = 0;
    server.use(
      http.get(daemonUrl(`/accounts/${DEFAULT_ACCOUNT.id}/signin`), () => {
        requests += 1;
        return HttpResponse.json(accountSignInDto({ command: 'claude /login' }));
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(<SignIn id={DEFAULT_ACCOUNT.id} />);
    expect(await screen.findByText('no command')).toBeTruthy();
    expect(requests).toBe(0);
    fireEvent.click(screen.getByText('enable'));
    expect(await screen.findByText('claude /login')).toBeTruthy();
    expect(requests).toBe(1);
  });

  it('probes the identity only when the mutation runs', async () => {
    let requests = 0;
    server.use(
      http.get(daemonUrl(`/accounts/${DEFAULT_ACCOUNT.id}/identity`), () => {
        requests += 1;
        return HttpResponse.json(accountIdentityDto({ email: 'seen@example.com' }));
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(<Identity id={DEFAULT_ACCOUNT.id} />);
    expect(await screen.findByText('unchecked')).toBeTruthy();
    expect(requests).toBe(0);
    fireEvent.click(screen.getByText('check'));
    expect(await screen.findByText('seen@example.com')).toBeTruthy();
    expect(requests).toBe(1);
  });
});
