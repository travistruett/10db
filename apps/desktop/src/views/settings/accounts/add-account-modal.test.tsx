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

interface Served {
  readonly posts: unknown[];
  /** The key requests, each as sent. */
  readonly after: string[];
  readonly judgeRequests: readonly { method: string; body: unknown }[];
}

function serve(
  refusal?: { status: number; message: string },
  opts: {
    judgeAccountId?: AccountId | null;
    /** False: the judge names an account the daemon no longer resolves, so its status has none. */
    judgeAccountResolves?: boolean;
    secretRefusal?: string;
  } = {},
): Served {
  const posts: unknown[] = [];
  const after: string[] = [];
  const live: AccountDto[] = [DEFAULT_ACCOUNT];
  const judgeRequests = serveJudge({
    status: judgeStatusDto({
      config: { ...judgeStatusDto().config, accountId: opts.judgeAccountId ?? null },
      account:
        opts.judgeAccountId == null || opts.judgeAccountResolves === false
          ? null
          : { id: opts.judgeAccountId, label: 'Other', secretSet: true, secretState: 'set' },
    }),
    accounts: live,
  });
  server.use(
    http.put(daemonUrl('/accounts/:accountId/secret'), async ({ request, params }) => {
      after.push(`PUT secret ${JSON.stringify(await request.json())}`);
      if (opts.secretRefusal !== undefined)
        return HttpResponse.json({ message: opts.secretRefusal }, { status: 409 });
      const account = live.find((a) => a.id === params['accountId']);
      if (!account) return HttpResponse.json({ message: 'unknown' }, { status: 404 });
      return HttpResponse.json({ ...account, secretSet: true });
    }),
    http.get(daemonUrl('/accounts'), () => HttpResponse.json(live)),
    http.post(daemonUrl('/accounts'), async ({ request }) => {
      const body: unknown = await request.json();
      posts.push(body);
      if (refusal)
        return HttpResponse.json({ message: refusal.message }, { status: refusal.status });
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
  return { posts, after, judgeRequests };
}

async function openModal(kindLabel: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Add Account' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add Account' });
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Kind' }));
  fireEvent.click(await screen.findByRole('option', { name: kindLabel, hidden: true }));
  return dialog;
}

function type(dialog: HTMLElement, name: string, value: string) {
  fireEvent.change(within(dialog).getByRole('textbox', { name }), { target: { value } });
}

describe('AddAccountModal', () => {
  it('adds a subscription and opens its sign-in steps', async () => {
    const { posts } = serve();
    const dialog = await openModal('Claude subscription');
    type(dialog, 'Label', 'Company A');
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

  it('adds Bedrock on an AWS profile and opens a drawer with no secret form', async () => {
    const { posts } = serve();
    const dialog = await openModal('Amazon Bedrock');
    type(dialog, 'Label', 'Client B');
    type(dialog, 'Region', 'us-west-2');
    type(dialog, 'AWS profile', 'client-b');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const drawer = await screen.findByRole('dialog', { name: /Client B/ });
    expect(
      within(drawer).queryByLabelText(/secret|token|key/i, { selector: 'input[type="password"]' }),
    ).toBeNull();
    expect(posts).toEqual([
      expect.objectContaining({
        kind: 'bedrock',
        settings: { region: 'us-west-2', awsProfile: 'client-b' },
      }),
    ]);
  });

  it('adds a gateway and opens its secret form', async () => {
    const { posts } = serve();
    const dialog = await openModal('Gateway');
    type(dialog, 'Label', 'Router');
    type(dialog, 'Base URL', 'https://gw.example.com/v1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const drawer = await screen.findByRole('dialog', { name: /Router/ });
    expect(await within(drawer).findByText('No secret yet')).toBeTruthy();
    expect(posts).toEqual([
      expect.objectContaining({
        kind: 'gateway',
        settings: { baseUrl: 'https://gw.example.com/v1' },
      }),
    ]);
  });

  it('shows the daemon’s refusal in the modal and keeps it open', async () => {
    serve({ status: 409, message: 'An account labelled "Company A" already exists' });
    const dialog = await openModal('Claude subscription');
    type(dialog, 'Label', 'Company A');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText(/already exists/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Add Account' })).toBeTruthy();
  });

  it('shows an invalid field’s error and sends nothing', async () => {
    const { posts } = serve();
    const dialog = await openModal('Gateway');
    type(dialog, 'Label', 'Router');
    type(dialog, 'Base URL', 'http://gw.example.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText(/https URL/)).toBeTruthy();
    expect(posts).toEqual([]);
  });

  it('names the modal’s close button', async () => {
    serve();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Account' });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('returns focus to Add Account when the new account’s drawer closes', async () => {
    serve();
    const add = await screen.findByRole('button', { name: 'Add Account' });
    const dialog = await openModal('Claude subscription');
    type(dialog, 'Label', 'Company A');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const drawer = await screen.findByRole('dialog', { name: /Company A/ });
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => {
      expect(document.activeElement).toBe(add);
    });
  });

  describe('an OpenRouter key', () => {
    const KEY = 'sk-or-v1-the-key-typed-here';
    const typeKey = (dialog: HTMLElement) => {
      fireEvent.change(within(dialog).getByLabelText('OpenRouter key', { selector: 'input' }), {
        target: { value: KEY },
      });
    };
    const patches = (served: Served) => served.judgeRequests.filter((r) => r.method === 'PATCH');

    it('takes a label, a payer and a key only, then runs decisions on it when they run on none', async () => {
      const served = serve();
      const dialog = await openModal('OpenRouter key');
      expect(within(dialog).queryByRole('textbox', { name: 'Lane cap' })).toBeNull();
      const run = within(dialog).getByRole('checkbox', { name: 'Run decisions on this account' });
      await waitFor(() => {
        expect(run).toHaveProperty('checked', true);
      });
      type(dialog, 'Label', 'OpenRouter');
      typeKey(dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      await screen.findByRole('dialog', { name: /OpenRouter/ });
      expect(served.posts).toEqual([{ kind: 'openrouter', label: 'OpenRouter', payer: '' }]);
      expect(served.after).toEqual([`PUT secret ${JSON.stringify({ secret: KEY })}`]);
      await waitFor(() => {
        expect(patches(served)).toEqual([
          expect.objectContaining({ body: { accountId: expect.any(String) as unknown } }),
        ]);
      });
    });

    it('leaves decisions where they are when the box is off or decisions already run on an account', async () => {
      const other = AccountId.parse(accountDto({ kind: 'openrouter', label: 'Other' }).id);
      const served = serve(undefined, { judgeAccountId: other });
      const dialog = await openModal('OpenRouter key');
      const run = within(dialog).getByRole('checkbox', { name: 'Run decisions on this account' });
      await waitFor(() => {
        expect(run).toHaveProperty('checked', false);
      });
      type(dialog, 'Label', 'Spare');
      typeKey(dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      await screen.findByRole('dialog', { name: /Spare/ });
      expect(served.after).toHaveLength(1);
      expect(patches(served)).toEqual([]);
    });

    it('keeps the account and says the key was not saved, without touching decisions', async () => {
      const served = serve(undefined, { secretRefusal: 'The Keychain refused the write' });
      const dialog = await openModal('OpenRouter key');
      await waitFor(() => {
        expect(
          within(dialog).getByRole('checkbox', { name: 'Run decisions on this account' }),
        ).toHaveProperty('checked', true);
      });
      type(dialog, 'Label', 'OpenRouter');
      typeKey(dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      expect(await within(dialog).findByText(/key wasn.t saved.*Keychain refused/)).toBeTruthy();
      expect(patches(served)).toEqual([]);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Open Account' }));
      const drawer = await screen.findByRole('dialog', { name: /OpenRouter/ });
      expect(await within(drawer).findByText('No secret yet')).toBeTruthy();
      expect(served.posts).toHaveLength(1);
    });

    it('trims the key before sending it', async () => {
      const served = serve();
      const dialog = await openModal('OpenRouter key');
      type(dialog, 'Label', 'OpenRouter');
      fireEvent.change(within(dialog).getByLabelText('OpenRouter key', { selector: 'input' }), {
        target: { value: `  ${KEY}\n` },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      await screen.findByRole('dialog', { name: /OpenRouter/ });
      expect(served.after).toEqual([`PUT secret ${JSON.stringify({ secret: KEY })}`]);
    });

    it('defaults the box on when the account decisions name no longer resolves', async () => {
      const gone = AccountId.parse(accountDto({ kind: 'openrouter' }).id);
      serve(undefined, { judgeAccountId: gone, judgeAccountResolves: false });
      const dialog = await openModal('OpenRouter key');
      const run = within(dialog).getByRole('checkbox', { name: 'Run decisions on this account' });
      await waitFor(() => {
        expect(run).toHaveProperty('checked', true);
      });
    });

    it('says the key was saved when only switching decisions over failed', async () => {
      serve();
      server.use(
        http.patch(daemonUrl('/judge'), () =>
          HttpResponse.json({ message: 'Account is archived' }, { status: 400 }),
        ),
      );
      const dialog = await openModal('OpenRouter key');
      await waitFor(() => {
        expect(
          within(dialog).getByRole('checkbox', { name: 'Run decisions on this account' }),
        ).toHaveProperty('checked', true);
      });
      type(dialog, 'Label', 'OpenRouter');
      typeKey(dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      expect(
        await within(dialog).findByText(/key was saved.*decisions weren.t switched.*archived/),
      ).toBeTruthy();
    });

    it('clears the key field before the request answers', async () => {
      serve();
      const dialog = await openModal('OpenRouter key');
      type(dialog, 'Label', 'OpenRouter');
      typeKey(dialog);
      const field = within(dialog).getByLabelText('OpenRouter key', { selector: 'input' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      expect((field as HTMLInputElement).value).toBe('');
    });
  });
});
