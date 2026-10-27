import { AccountDto, AccountId } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { accountDto, accountUsageDto, DEFAULT_ACCOUNT } from '../../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';

const PASTED = 'pasted-value-never-echoed';
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

let spies: MockInstance[] = [];

beforeEach(() => {
  spies = CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

function assertNoSecret(queryClient: ReturnType<typeof renderApp>['queryClient']) {
  expect(screen.queryByDisplayValue(PASTED)).toBeNull();
  expect(document.body.innerHTML).not.toContain(PASTED);
  expect(
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
    ),
  ).not.toContain(PASTED);
  expect(
    JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    ),
  ).not.toContain(PASTED);
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(PASTED);
    }
  }
}

interface Served {
  readonly bodies: unknown[];
  readonly queryClient: ReturnType<typeof renderApp>['queryClient'];
}

/** Serves one gateway account whose secret the PUT sets, and opens its drawer. */
async function openGateway(
  put: (body: unknown, set: () => AccountDto) => Promise<Response> | Response,
  account = accountDto({
    kind: 'gateway',
    label: 'Proxy',
    settings: { baseUrl: 'https://gateway.example.com' },
    secretSet: false,
  }),
): Promise<Served & { dialog: HTMLElement }> {
  const bodies: unknown[] = [];
  let live = account;
  server.use(
    http.get(daemonUrl('/accounts'), () => HttpResponse.json([DEFAULT_ACCOUNT, live])),
    http.get(daemonUrl('/accounts/:accountId/usage'), ({ params }) =>
      HttpResponse.json(accountUsageDto({ accountId: AccountId.parse(params['accountId']) })),
    ),
    http.put(daemonUrl('/accounts/:accountId/secret'), async ({ request }) => {
      const body: unknown = await request.json();
      bodies.push(body);
      return put(body, () => {
        live = AccountDto.parse({ ...live, secretSet: true });
        return live;
      });
    }),
    ...baseHandlers(),
  );
  const { queryClient } = renderApp('/settings/accounts');
  const table = await screen.findByRole('table', { name: 'Accounts' });
  fireEvent.click(await within(table).findByRole('button', { name: 'Open Proxy' }));
  const dialog = await screen.findByRole('dialog', { name: (n) => n.startsWith('Proxy') });
  return { bodies, queryClient, dialog };
}

function field(dialog: HTMLElement): HTMLInputElement {
  const input = within(dialog).getByLabelText('Gateway token');
  if (!(input instanceof HTMLInputElement)) throw new Error('not an input');
  return input;
}

function paste(dialog: HTMLElement, value: string) {
  fireEvent.change(field(dialog), { target: { value } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save secret' }));
}

describe('SecretForm', () => {
  it('sends the secret once, then shows Secret set with an empty field', async () => {
    const { bodies, queryClient, dialog } = await openGateway((_body, set) =>
      HttpResponse.json(set()),
    );
    expect(await within(dialog).findByText('No secret yet')).toBeTruthy();
    expect(field(dialog).type).toBe('password');
    paste(dialog, PASTED);
    await waitFor(() => {
      expect(within(dialog).getByText('Secret set')).toBeTruthy();
    });
    expect(bodies).toEqual([{ secret: PASTED }]);
    expect(within(dialog).getByRole('button', { name: 'Replace secret' })).toBeTruthy();
    expect(field(dialog).value).toBe('');
    assertNoSecret(queryClient);
  });

  it('empties the field while the request is in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bodies, queryClient, dialog } = await openGateway(async (_body, set) => {
      await gate;
      return HttpResponse.json(set());
    });
    await within(dialog).findByText('No secret yet');
    paste(dialog, PASTED);
    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(field(dialog).value).toBe('');
    assertNoSecret(queryClient);
    release();
    await waitFor(() => {
      expect(within(dialog).getByText('Secret set')).toBeTruthy();
    });
    assertNoSecret(queryClient);
  });

  it('shows the daemon’s refusal and keeps no secret', async () => {
    const message = 'No Keychain is available to this daemon, so account:acc_… was not written';
    const { queryClient, dialog } = await openGateway(() =>
      HttpResponse.json({ error: 'conflict', message }, { status: 409 }),
    );
    await within(dialog).findByText('No secret yet');
    paste(dialog, PASTED);
    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(field(dialog).value).toBe('');
    assertNoSecret(queryClient);
  });

  it('shows a fixed message when the daemon cannot be reached', async () => {
    const { queryClient, dialog } = await openGateway(() => HttpResponse.error());
    await within(dialog).findByText('No secret yet');
    paste(dialog, PASTED);
    expect(
      await within(dialog).findByText("Couldn't reach the daemon; paste the secret again to retry"),
    ).toBeTruthy();
    expect(field(dialog).value).toBe('');
    assertNoSecret(queryClient);
  });

  it('refuses a too-short value before any request, with zod’s message', async () => {
    const { bodies, dialog } = await openGateway((_body, set) => HttpResponse.json(set()));
    await within(dialog).findByText('No secret yet');
    paste(dialog, 'short');
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByRole('alert').textContent).not.toContain('short');
    expect(bodies).toEqual([]);
    expect(field(dialog).value).toBe('');
  });

  it('keeps no secret when the drawer closes mid-request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bodies, queryClient, dialog } = await openGateway(async (_body, set) => {
      await gate;
      return HttpResponse.json(set());
    });
    await within(dialog).findByText('No secret yet');
    paste(dialog, PASTED);
    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    release();
    await waitFor(() => {
      expect(
        queryClient.getQueryData<AccountDto[]>(['accounts'])?.find((a) => a.label === 'Proxy')
          ?.secretSet,
      ).toBe(true);
    });
    assertNoSecret(queryClient);
  });

  it('has no control that reveals the field', async () => {
    const { dialog } = await openGateway((_body, set) => HttpResponse.json(set()));
    await within(dialog).findByText('No secret yet');
    expect(within(dialog).queryByRole('button', { name: /show|toggle/i })).toBeNull();
    expect(field(dialog).autocomplete).toBe('new-password');
  });
});
