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

/**
 * React DOM keeps the last value it saw in a tracker on the input node (`_valueTracker`). It is
 * internal, so it is read through `Reflect` and narrowed rather than cast. A missing tracker returns
 * null, which fails the check on purpose: a renamed internal must not pass silently.
 */
function trackedValue(input: HTMLInputElement): string | null {
  const tracker: unknown = Reflect.get(input, '_valueTracker');
  if (typeof tracker !== 'object' || tracker === null || !('getValue' in tracker)) return null;
  const read: unknown = tracker.getValue;
  if (typeof read !== 'function') return null;
  const value: unknown = Reflect.apply(read, tracker, []);
  return typeof value === 'string' ? value : null;
}

function assertNoSecret(queryClient: ReturnType<typeof renderApp>['queryClient']) {
  expect(screen.queryByDisplayValue(PASTED)).toBeNull();
  expect(document.body.innerHTML).not.toContain(PASTED);
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="secret"]')) {
    expect(trackedValue(input)).toBe('');
  }
  expect(
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => ({ key: q.queryKey, hash: q.queryHash, state: q.state })),
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
  // The form has no reason to log; a silent spy would also hide React's own warnings.
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
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
    expect(within(dialog).getByText('Secret saved to your login Keychain.')).toBeTruthy();
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
    const { bodies, queryClient, dialog } = await openGateway(() =>
      HttpResponse.json({ error: 'conflict', message }, { status: 409 }),
    );
    await within(dialog).findByText('No secret yet');
    paste(dialog, PASTED);
    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(field(dialog).value).toBe('');
    assertNoSecret(queryClient);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save secret' }));
    expect(
      await within(dialog).findByText('Too small: expected string to have >=8 characters'),
    ).toBeTruthy();
    expect(bodies).toHaveLength(1);
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
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Too small: expected string to have >=8 characters',
    );
    expect(bodies).toEqual([]);
    expect(field(dialog).value).toBe('');
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('refreshes the list and says so when the answer is not understood', async () => {
    const { queryClient, dialog } = await openGateway((_body, set) => {
      set();
      return HttpResponse.json({ unexpected: true });
    });
    await within(dialog).findByText('No secret yet');
    paste(dialog, PASTED);
    expect(
      await within(dialog).findByText(
        "The daemon answered in a form this version of 10db doesn't understand; check the badge before pasting again.",
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(within(dialog).getByText('Secret set')).toBeTruthy();
    });
    assertNoSecret(queryClient);
  });

  it('sends one request when submitted twice while the first is in flight', async () => {
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
    fireEvent.change(field(dialog), { target: { value: PASTED } });
    fireEvent.submit(field(dialog));
    expect(bodies).toHaveLength(1);
    expect(
      within(dialog).getByRole('button', { name: 'Save secret' }).hasAttribute('data-loading'),
    ).toBe(true);
    release();
    await waitFor(() => {
      expect(within(dialog).getByText('Secret set')).toBeTruthy();
    });
    expect(bodies).toHaveLength(1);
    assertNoSecret(queryClient);
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
