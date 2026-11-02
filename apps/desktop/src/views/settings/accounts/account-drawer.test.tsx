import {
  AccountDto,
  AccountId,
  AccountPatch,
  mintId,
  type AccountPauseDto,
  type AccountUsageDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountKeys } from '../../../daemon/account-queries';
import {
  accountDto,
  accountIdentityDto,
  accountPauseDto,
  accountSignInDto,
  accountUsageDto,
  DEFAULT_ACCOUNT,
} from '../../../test/account-fixtures';
import {
  baseHandlers,
  daemonUrl,
  eventStream,
  renderApp,
  renderWithDaemon,
  server,
} from '../../../test/daemon';
import { daemonEvent } from '../../../test/fixtures';
import { AccountDrawer } from './account-drawer';
import { formatMoment } from './account-pause';

interface Served {
  readonly patches: { id: string; body: unknown }[];
  readonly identityCalls: string[];
  readonly archives: string[];
  /** Changes the account on the daemon and tells the open window with an `account.saved` event. */
  readonly changeRemotely: (id: string, changes: Partial<AccountDto>) => void;
  readonly accountListCalls: number;
  readonly queryClient: ReturnType<typeof renderApp>['queryClient'];
}

function serve(
  accounts: AccountDto[],
  opts: {
    identity?: Record<string, ReturnType<typeof accountIdentityDto>>;
    identityStatus?: { status: number; message: string };
    usage?: Record<string, AccountUsageDto>;
    /** Holds the identity answer until it resolves. */
    identityGate?: Promise<void>;
    patchRefusal?: { status: number; message: string };
    archiveRefusal?: { status: number; message: string };
    /** The pauses the daemon reports. */
    pauses?: AccountPauseDto[];
  } = {},
): Served {
  const patches: Served['patches'] = [];
  const identityCalls: string[] = [];
  const archives: string[] = [];
  const sockets: { send(data: string): void }[] = [];
  let accountListCalls = 0;
  const live = [...accounts];
  server.use(
    http.get(daemonUrl('/accounts'), () => {
      accountListCalls += 1;
      return HttpResponse.json(live);
    }),
    http.get(daemonUrl('/accounts/:accountId/usage'), ({ params }) =>
      HttpResponse.json(
        opts.usage?.[String(params['accountId'])] ??
          accountUsageDto({ accountId: AccountId.parse(params['accountId']) }),
      ),
    ),
    http.get(daemonUrl('/accounts/pauses'), () => HttpResponse.json(opts.pauses ?? [])),
    http.post(daemonUrl('/accounts/:accountId/resume'), ({ params }) => {
      resumes.push(String(params['accountId']));
      return HttpResponse.json([]);
    }),
    http.get(daemonUrl('/accounts/:accountId/signin'), ({ params }) =>
      HttpResponse.json(accountSignInDto({ accountId: AccountId.parse(params['accountId']) })),
    ),
    http.get(daemonUrl('/accounts/:accountId/identity'), async ({ params }) => {
      const id = String(params['accountId']);
      identityCalls.push(id);
      await opts.identityGate;
      if (opts.identityStatus)
        return HttpResponse.json(
          { message: opts.identityStatus.message },
          { status: opts.identityStatus.status },
        );
      return HttpResponse.json(opts.identity?.[id] ?? accountIdentityDto());
    }),
    http.patch(daemonUrl('/accounts/:accountId'), async ({ params, request }) => {
      const id = String(params['accountId']);
      const body = AccountPatch.parse(await request.json());
      patches.push({ id, body });
      if (opts.patchRefusal)
        return HttpResponse.json(
          { message: opts.patchRefusal.message },
          { status: opts.patchRefusal.status },
        );
      const index = live.findIndex((a) => a.id === id);
      const current = live[index];
      if (!current) return HttpResponse.json({ message: 'no such account' }, { status: 404 });
      const next = AccountDto.parse({ ...current, ...body });
      live[index] = next;
      return HttpResponse.json(next);
    }),
    http.post(daemonUrl('/accounts/:accountId/archive'), ({ params }) => {
      const id = String(params['accountId']);
      archives.push(id);
      if (opts.archiveRefusal)
        return HttpResponse.json(
          { message: opts.archiveRefusal.message },
          { status: opts.archiveRefusal.status },
        );
      const index = live.findIndex((a) => a.id === id);
      const current = live[index];
      if (!current) return HttpResponse.json({ message: 'no such account' }, { status: 404 });
      const next = AccountDto.parse({ ...current, archived: true });
      live[index] = next;
      return HttpResponse.json(next);
    }),
    eventStream.addEventListener('connection', ({ client }) => {
      sockets.push(client);
    }),
    ...baseHandlers(),
  );
  const { queryClient } = renderApp('/settings/accounts');
  return {
    patches,
    identityCalls,
    archives,
    changeRemotely: (id, changes) => {
      const index = live.findIndex((a) => a.id === id);
      const current = live[index];
      if (!current) return;
      live[index] = AccountDto.parse({ ...current, ...changes });
      sockets[0]?.send(
        JSON.stringify(
          daemonEvent({ seq: 1, type: 'account.saved', entityType: 'account', entityId: id }),
        ),
      );
    },
    queryClient,
    get accountListCalls() {
      return accountListCalls;
    },
  };
}

async function openDrawer(label: string) {
  const table = await screen.findByRole('table', { name: 'Accounts' });
  fireEvent.click(await within(table).findByRole('button', { name: `Open ${label}` }));
  return screen.findByRole('dialog', { name: (name) => name.startsWith(label) });
}

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

/** The accounts a Resume button was pressed for. */
const resumes: string[] = [];

afterEach(() => {
  resumes.length = 0;
  writeText.mockClear();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('AccountDrawer', () => {
  it('shows the account’s pause with a Resume that lifts a refusal', async () => {
    const pause = accountPauseDto({ accountId: DEFAULT_ACCOUNT.id, reason: 'refused' });
    serve([DEFAULT_ACCOUNT], { pauses: [pause] });
    const dialog = await openDrawer('Claude plan');
    expect(await within(dialog).findByText(/Sessions refused/)).toBeTruthy();
    expect(within(dialog).getByText(new RegExp(`since ${formatMoment(pause.since)}`))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resume Claude plan' }));
    await waitFor(() => {
      expect(resumes).toEqual([DEFAULT_ACCOUNT.id]);
    });
  });

  it('shows a usage-limit pause in the drawer with no Resume', async () => {
    serve([DEFAULT_ACCOUNT], {
      pauses: [accountPauseDto({ reason: 'usage_limit', until: '2026-10-30T23:30:00.000Z' })],
    });
    const dialog = await openDrawer('Claude plan');
    expect(await within(dialog).findByText(/Usage limit reached/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Resume/ })).toBeNull();
  });

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
    expect(
      await within(dialog).findByText('CLAUDE_CONFIG_DIR=/data/accounts/a/claude claude'),
    ).toBeTruthy();
    expect(await within(dialog).findByText('No sessions this month')).toBeTruthy();
    const before = served.accountListCalls;
    await served.queryClient.invalidateQueries({ queryKey: accountKeys.all });
    expect(served.accountListCalls).toBeGreaterThan(before);
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
    expect(await screen.findByText('client@example.com')).toBeTruthy();
  });

  it('warns that a different recorded identity will be replaced', async () => {
    const account = accountDto({ label: 'Switched', expectedIdentity: 'old@example.com' });
    const served = serve([DEFAULT_ACCOUNT, account], {
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
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm new@example.com' }));
    await waitFor(() => {
      expect(served.patches).toEqual([
        { id: account.id, body: { expectedIdentity: 'new@example.com' } },
      ]);
    });
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
        [a.id]: accountIdentityDto({
          accountId: a.id,
          email: 'a@example.com',
          refusal: {
            problem: 'unconfirmed',
            message: 'No identity recorded yet.',
            seenIdentity: 'a@example.com',
          },
        }),
        [b.id]: accountIdentityDto({
          accountId: b.id,
          email: 'b@example.com',
          refusal: {
            problem: 'unconfirmed',
            message: 'No identity recorded yet.',
            seenIdentity: 'b@example.com',
          },
        }),
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

  it.each([
    { problem: 'wrong_credentials', message: 'Wrong credentials.' },
    { problem: 'signed_out', message: 'Signed out.' },
  ] as const)(
    'offers no Confirm for a $problem refusal even with an email',
    async ({ problem, message }) => {
      const account = accountDto({ label: 'Refused' });
      serve([DEFAULT_ACCOUNT, account], {
        identity: {
          [account.id]: accountIdentityDto({
            accountId: account.id,
            email: 'someone@example.com',
            refusal: { problem, message, seenIdentity: 'someone@example.com' },
          }),
        },
      });
      const dialog = await openDrawer('Refused');
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
      expect(await within(dialog).findByText(message)).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: /^Confirm / })).toBeNull();
    },
  );

  it('treats a recorded identity that differs only in case as matching', async () => {
    const account = accountDto({ label: 'Cased', expectedIdentity: 'Builder@Example.com' });
    serve([DEFAULT_ACCOUNT, account], {
      identity: {
        [account.id]: accountIdentityDto({ accountId: account.id, email: 'builder@example.com' }),
      },
    });
    const dialog = await openDrawer('Cased');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(await within(dialog).findByText('Signed in as builder@example.com')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Confirm / })).toBeNull();
    expect(within(dialog).queryByText(/will run as/)).toBeNull();
  });

  it('offers Require for a Bedrock account that reports an organization', async () => {
    const account = accountDto({ label: 'Cloud', kind: 'bedrock', secretSet: true });
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
    const dialog = await openDrawer('Cloud');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Require Acme' }));
    await waitFor(() => {
      expect(served.patches).toEqual([{ id: account.id, body: { expectedIdentity: 'Acme' } }]);
    });
  });

  it('says Claude Code is starting while the probe is in flight', async () => {
    let release: () => void = () => undefined;
    const identityGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    serve([DEFAULT_ACCOUNT, accountDto({ label: 'Slow' })], { identityGate });
    const dialog = await openDrawer('Slow');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Check sign-in' }));
    expect(
      await within(dialog).findByText('Starting Claude Code to read the account…'),
    ).toBeTruthy();
    release();
    await waitFor(() => {
      expect(within(dialog).queryByText('Starting Claude Code to read the account…')).toBeNull();
    });
  });

  it.each([
    {
      name: 'the Close button',
      close: (dialog: HTMLElement) => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      },
    },
    {
      name: 'Escape',
      close: (dialog: HTMLElement) => {
        fireEvent.keyDown(dialog, { key: 'Escape' });
      },
    },
  ])('returns focus to the row’s open button after $name', async ({ close }) => {
    serve([DEFAULT_ACCOUNT]);
    const table = await screen.findByRole('table', { name: 'Accounts' });
    const opener = await within(table).findByRole('button', { name: 'Open Claude plan' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    close(dialog);
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('saves exactly the fields that changed and the row shows the new label', async () => {
    const account = accountDto({ label: 'Fresh login' });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Fresh login');
    const save = await within(dialog).findByRole('button', { name: 'Save Changes' });
    expect(save).toHaveProperty('disabled', true);
    expect(within(dialog).getByDisplayValue('Claude subscription')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Label' }), {
      target: { value: 'Renamed' },
    });
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(save);
    await waitFor(() => {
      expect(served.patches).toEqual([{ id: account.id, body: { label: 'Renamed' } }]);
    });
    expect(await screen.findByRole('button', { name: 'Open Renamed', hidden: true })).toBeTruthy();
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Save Changes' })).toHaveProperty(
        'disabled',
        true,
      );
    });
  });

  it('shows the plain-word message for an invalid field without sending anything', async () => {
    const served = serve([DEFAULT_ACCOUNT, accountDto({ label: 'Fresh login' })]);
    const dialog = await openDrawer('Fresh login');
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Label' }), {
      target: { value: '' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    expect(await within(dialog).findByText('Enter a label')).toBeTruthy();
    expect(served.patches).toEqual([]);
  });

  it('shows the daemon’s message when a patch is refused', async () => {
    serve([DEFAULT_ACCOUNT, accountDto({ label: 'Fresh login' })], {
      patchRefusal: { status: 409, message: 'An account labelled "Taken" already exists' },
    });
    const dialog = await openDrawer('Fresh login');
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Label' }), {
      target: { value: 'Taken' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    expect(
      await within(dialog).findByText('An account labelled "Taken" already exists'),
    ).toBeTruthy();
  });

  it('clears a monthly cap by sending null', async () => {
    const account = accountDto({
      label: 'Metered',
      kind: 'anthropic_api_key',
      secretSet: true,
      monthlyCapUsd: 500,
    });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Metered');
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Monthly cap (USD)' }), {
      target: { value: '' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(served.patches).toEqual([{ id: account.id, body: { monthlyCapUsd: null } }]);
    });
  });

  it('says what switching a Bedrock account to a profile does to the stored token', async () => {
    const account = accountDto({
      label: 'Cloud',
      kind: 'bedrock',
      secretSet: true,
      settings: { region: 'us-west-2', awsProfile: null },
    });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Cloud');
    expect(
      await within(dialog).findByText(/forgets any stored bearer token.*pasted again/),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('textbox', { name: 'Organization' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'AWS profile' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'AWS profile' }), {
      target: { value: 'client-b' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(served.patches).toEqual([
        { id: account.id, body: { settings: { region: 'us-west-2', awsProfile: 'client-b' } } },
      ]);
    });
  });

  it('takes a remote change into a clean form, so Save stays off', async () => {
    const account = accountDto({ label: 'Fresh login' });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Fresh login');
    const lanes = await within(dialog).findByRole('textbox', { name: 'Lane cap' });
    expect(lanes).toHaveProperty('value', '4');
    served.changeRemotely(account.id, { laneCap: 8 });
    await waitFor(() => {
      expect(within(dialog).getByRole('textbox', { name: 'Lane cap' })).toHaveProperty(
        'value',
        '8',
      );
    });
    expect(within(dialog).getByRole('button', { name: 'Save Changes' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('keeps the builder’s edits and takes the rest of a remote change', async () => {
    const account = accountDto({ label: 'Fresh login' });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Fresh login');
    fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Label' }), {
      target: { value: 'Mid edit' },
    });
    served.changeRemotely(account.id, { laneCap: 8 });
    await waitFor(() => {
      expect(within(dialog).getByRole('textbox', { name: 'Lane cap' })).toHaveProperty(
        'value',
        '8',
      );
    });
    expect(within(dialog).getByRole('textbox', { name: 'Label' })).toHaveProperty(
      'value',
      'Mid edit',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(served.patches).toEqual([{ id: account.id, body: { label: 'Mid edit' } }]);
    });
  });

  it('archives after a confirmation and closes the drawer', async () => {
    const account = accountDto({ label: 'Old client' });
    const served = serve([DEFAULT_ACCOUNT, account]);
    const dialog = await openDrawer('Old client');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive Account' }));
    const confirm = await screen.findByRole('dialog', { name: 'Archive Old client?' });
    expect(
      within(confirm).getByText(
        "Old client stops taking projects. Archived accounts can't be restored.",
      ),
    ).toBeTruthy();
    expect(served.archives).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive Account' }));
    await waitFor(() => {
      expect(served.archives).toEqual([account.id]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add Account' }));
    });
  });

  it('closes only the confirmation on Escape, keeping the drawer and sending nothing', async () => {
    const account = accountDto({ label: 'Old client' });
    const archives: string[] = [];
    const onClose = vi.fn();
    server.use(
      http.get(daemonUrl('/accounts'), () => HttpResponse.json([DEFAULT_ACCOUNT, account])),
      http.get(daemonUrl('/accounts/:accountId/usage'), ({ params }) =>
        HttpResponse.json(accountUsageDto({ accountId: AccountId.parse(params['accountId']) })),
      ),
      http.post(daemonUrl('/accounts/:accountId/archive'), ({ params }) => {
        archives.push(String(params['accountId']));
        return new HttpResponse(null, { status: 500 });
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(<AccountDrawer accountId={account.id} opened onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: /Old client/ });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive Account' }));
    await screen.findByRole('dialog', { name: 'Archive Old client?' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Archive Old client?' })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(archives).toEqual([]);
  });

  it('forgets an open confirmation when its account is archived elsewhere', async () => {
    const first = accountDto({ label: 'First client' });
    const second = accountDto({ label: 'Second client' });
    const served = serve([DEFAULT_ACCOUNT, first, second]);
    const dialog = await openDrawer('First client');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive Account' }));
    await screen.findByRole('dialog', { name: 'Archive First client?' });
    served.changeRemotely(first.id, { archived: true });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Archive First client?' })).toBeNull();
    });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /First client/ })).toBeNull();
    });
    const next = await openDrawer('Second client');
    expect(within(next).getByRole('button', { name: 'Archive Account' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Archive Second client?' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Second client/ })).toBeNull();
    });
  });

  it('shows the daemon’s reason when an archive is refused, and keeps the drawer open', async () => {
    const account = accountDto({ label: 'In use' });
    serve([DEFAULT_ACCOUNT, account], {
      archiveRefusal: { status: 409, message: 'Move "Demo" to another account before archiving' },
    });
    const dialog = await openDrawer('In use');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive Account' }));
    const confirm = await screen.findByRole('dialog', { name: 'Archive In use?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive Account' }));
    expect(
      await within(confirm).findByText('Move "Demo" to another account before archiving'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: (n) => n.startsWith('In use') })).toBeTruthy();
  });

  it('offers no Archive for the default account and says why', async () => {
    serve([DEFAULT_ACCOUNT]);
    const dialog = await openDrawer('Claude plan');
    expect(await within(dialog).findByText("The default account can't be archived.")).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Archive Account' })).toBeNull();
  });
});
