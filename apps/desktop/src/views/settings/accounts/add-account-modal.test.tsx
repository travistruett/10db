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

interface Served {
  readonly posts: unknown[];
}

function serve(refusal?: { status: number; message: string }): Served {
  const posts: unknown[] = [];
  const live: AccountDto[] = [DEFAULT_ACCOUNT];
  server.use(
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
        settings: input.settings,
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
  return { posts };
}

async function openModal(kindLabel: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add account' });
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
    expect(await within(drawer).findByText('1. In Terminal, run')).toBeTruthy();
    expect(posts).toEqual([
      { kind: 'claude_subscription', label: 'Company A', payer: '', laneCap: 4, settings: {} },
    ]);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add account' })).toBeNull();
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

  it('adds a gateway with a model map and opens its secret form', async () => {
    const { posts } = serve();
    const dialog = await openModal('Gateway');
    type(dialog, 'Label', 'Router');
    type(dialog, 'Base URL', 'https://gw.example.com/v1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add model mapping' }));
    type(dialog, 'Alias, row 1', 'sonnet');
    type(dialog, 'Model ID, row 1', 'anthropic/claude-sonnet');
    const tags = within(dialog).getByRole('combobox', { name: 'Offered aliases' });
    tags.focus();
    fireEvent.change(tags, { target: { value: 'sonnet' } });
    fireEvent.blur(tags);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const drawer = await screen.findByRole('dialog', { name: /Router/ });
    expect(await within(drawer).findByText('No secret yet')).toBeTruthy();
    expect(posts).toEqual([
      expect.objectContaining({
        kind: 'gateway',
        settings: {
          baseUrl: 'https://gw.example.com/v1',
          modelMap: { sonnet: 'anthropic/claude-sonnet' },
          aliases: ['sonnet'],
        },
      }),
    ]);
  });

  it('shows the daemon’s refusal in the modal and keeps it open', async () => {
    serve({ status: 409, message: 'An account labelled "Company A" already exists' });
    const dialog = await openModal('Claude subscription');
    type(dialog, 'Label', 'Company A');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText(/already exists/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Add account' })).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add account' });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('returns focus to Add account when the new account’s drawer closes', async () => {
    serve();
    const add = await screen.findByRole('button', { name: 'Add account' });
    const dialog = await openModal('Claude subscription');
    type(dialog, 'Label', 'Company A');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const drawer = await screen.findByRole('dialog', { name: /Company A/ });
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => {
      expect(document.activeElement).toBe(add);
    });
  });

  it('moves focus through the model map rows as they are added and removed', async () => {
    serve();
    const dialog = await openModal('Claude subscription');
    const add = within(dialog).getByRole('button', { name: 'Add model mapping' });
    fireEvent.click(add);
    expect(document.activeElement).toBe(
      within(dialog).getByRole('textbox', { name: 'Alias, row 1' }),
    );
    type(dialog, 'Alias, row 1', 'sonnet');
    fireEvent.click(add);
    expect(document.activeElement).toBe(
      within(dialog).getByRole('textbox', { name: 'Alias, row 2' }),
    );
    expect(within(dialog).getByRole('textbox', { name: 'Model ID, row 2' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove sonnet mapping' }));
    expect(document.activeElement).toBe(
      within(dialog).getByRole('textbox', { name: 'Alias, row 1' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove row 1 mapping' }));
    expect(document.activeElement).toBe(add);
  });

  it('names Remove buttons by row when two rows share an alias', async () => {
    serve();
    const dialog = await openModal('Claude subscription');
    const add = within(dialog).getByRole('button', { name: 'Add model mapping' });
    fireEvent.click(add);
    type(dialog, 'Alias, row 1', 'sonnet');
    fireEvent.click(add);
    type(dialog, 'Alias, row 2', 'sonnet ');
    expect(within(dialog).getByRole('button', { name: 'Remove row 1 mapping' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Remove row 2 mapping' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Remove sonnet mapping' })).toBeNull();
  });

  it('ties a model map error to its rows', async () => {
    const { posts } = serve();
    const dialog = await openModal('Claude subscription');
    type(dialog, 'Label', 'Company A');
    const add = within(dialog).getByRole('button', { name: 'Add model mapping' });
    fireEvent.click(add);
    fireEvent.click(add);
    for (const row of ['1', '2']) {
      type(dialog, `Alias, row ${row}`, 'sonnet');
      type(dialog, `Model ID, row ${row}`, 'x');
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const message = await within(dialog).findByText('Each alias can appear once');
    const alias = within(dialog).getByRole('textbox', { name: 'Alias, row 1' });
    expect(alias.getAttribute('aria-invalid')).toBe('true');
    expect(alias.getAttribute('aria-describedby')).toBe(message.id);
    expect(posts).toEqual([]);
  });
});
