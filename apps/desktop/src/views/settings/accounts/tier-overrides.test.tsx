import { AccountPatch, type AccountDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountDto } from '../../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../../test/daemon';
import { accountModelDto, modelRowDto, someAccountId } from '../../../test/model-fixtures';
import { EditAccountForm } from './edit-account-form';

const OTHER = someAccountId();

/** The catalogue's rows: three the gateway lists, one it does not, one superseded. */
const rows = (account: AccountDto) => [
  modelRowDto({ model: 'small', name: 'Small', tier: 'efficient', availableOn: [account.id] }),
  modelRowDto({ model: 'mid', name: 'Mid', tier: 'balanced', availableOn: [account.id] }),
  modelRowDto({ model: 'large', name: 'Large', tier: 'capable', availableOn: [account.id] }),
  modelRowDto({ model: 'top', name: 'Top', tier: 'frontier', availableOn: [account.id] }),
  modelRowDto({ model: 'elsewhere', name: 'Elsewhere', tier: 'efficient', availableOn: [OTHER] }),
  modelRowDto({
    model: 'old',
    name: 'Old',
    tier: 'efficient',
    status: 'superseded',
    availableOn: [account.id],
  }),
];

/** Serves the model list and the account's offers; `listed` false is a gateway that reports no list. */
function serve(account: AccountDto, listed: boolean): unknown[] {
  const patches: unknown[] = [];
  server.use(
    http.get(daemonUrl('/models'), () => HttpResponse.json(rows(account))),
    http.get(daemonUrl('/models/offers'), () =>
      HttpResponse.json(
        listed
          ? ['small', 'mid', 'large', 'top', 'old'].map((model) =>
              accountModelDto({ accountId: account.id, model }),
            )
          : [accountModelDto({ accountId: OTHER, model: 'elsewhere' })],
      ),
    ),
    http.patch(daemonUrl('/accounts/:accountId'), async ({ request }) => {
      patches.push(AccountPatch.parse(await request.json()));
      return HttpResponse.json(account);
    }),
    ...baseHandlers(),
  );
  return patches;
}

const gateway = (tierOverrides?: Record<string, string>) =>
  accountDto({
    kind: 'gateway',
    label: 'Router',
    settings: { baseUrl: 'https://gw.example.com/v1', ...(tierOverrides ? { tierOverrides } : {}) },
  });

/** Opens a tier's dropdown and picks an option from that dropdown's own list. */
async function choose(label: string, option: string) {
  fireEvent.click(await screen.findByRole('combobox', { name: label }));
  const list = within(await screen.findByRole('listbox', { name: label, hidden: true }));
  fireEvent.click(await list.findByRole('option', { name: option, hidden: true }));
}

describe('the tier overrides in an account’s settings', () => {
  it('lists, for each of the four tiers, Automatic and only the models the account offers, grouped by tier and a replaced one marked', async () => {
    const account = gateway();
    serve(account, true);
    renderWithDaemon(<EditAccountForm account={account} />);
    for (const label of ['Efficient model', 'Balanced model', 'Capable model', 'Frontier model']) {
      fireEvent.click(await screen.findByRole('combobox', { name: label }));
      const list = within(await screen.findByRole('listbox', { name: label, hidden: true }));
      await waitFor(() => {
        expect(list.getAllByRole('option', { hidden: true }).map((o) => o.textContent)).toEqual([
          'Automatic',
          'Small',
          'Old (superseded)',
          'Mid',
          'Large',
          'Top',
        ]);
      });
      fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'Escape' });
    }
  });

  it('saves a chosen model as that tier’s override, and Automatic takes it away again', async () => {
    const account = gateway({ capable: 'large' });
    const patches = serve(account, true);
    renderWithDaemon(<EditAccountForm account={account} />);
    await choose('Efficient model', 'Small');
    await choose('Frontier model', 'Top');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(patches).toEqual([
        {
          settings: {
            baseUrl: 'https://gw.example.com/v1',
            tierOverrides: { efficient: 'small', capable: 'large', frontier: 'top' },
          },
        },
      ]);
    });
    await choose('Capable model', 'Automatic');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(patches[1]).toEqual({
        settings: {
          baseUrl: 'https://gw.example.com/v1',
          tierOverrides: { efficient: 'small', frontier: 'top' },
        },
      });
    });
  });

  it('keeps a saved override the account no longer offers on show, marked, so the field is never blank', async () => {
    const account = gateway({ efficient: 'retired-one' });
    serve(account, true);
    renderWithDaemon(<EditAccountForm account={account} />);
    const fast = await screen.findByRole('combobox', { name: 'Efficient model' });
    await waitFor(() => {
      expect(fast).toHaveProperty('value', 'retired-one (not offered)');
    });
  });

  it('gives a gateway that reports no list a text field per tier and saves what is typed', async () => {
    const account = gateway();
    const patches = serve(account, false);
    renderWithDaemon(<EditAccountForm account={account} />);
    const fast = await screen.findByRole('textbox', { name: 'Efficient model' });
    expect(screen.queryByRole('combobox', { name: 'Efficient model' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Balanced model' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Capable model' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Frontier model' })).toBeTruthy();
    fireEvent.change(fast, { target: { value: 'vendor/small' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(patches).toEqual([
        {
          settings: {
            baseUrl: 'https://gw.example.com/v1',
            tierOverrides: { efficient: 'vendor/small' },
          },
        },
      ]);
    });
  });

  it('shows a tier’s name typed as a model as an error on its field and sends nothing', async () => {
    const account = gateway();
    const patches = serve(account, false);
    renderWithDaemon(<EditAccountForm account={account} />);
    const strongest = await screen.findByRole('textbox', { name: 'Capable model' });
    fireEvent.change(strongest, { target: { value: 'efficient' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    const message = await screen.findByText(
      'Enter a model ID of up to 200 characters, not a tier name',
    );
    expect(strongest.getAttribute('aria-describedby')).toContain(message.id);
    expect(patches).toEqual([]);
  });

  it('shows an over-long model ID as an error on its field and sends nothing', async () => {
    const account = gateway();
    const patches = serve(account, false);
    renderWithDaemon(<EditAccountForm account={account} />);
    const fast = await screen.findByRole('textbox', { name: 'Efficient model' });
    fireEvent.change(fast, { target: { value: 'x'.repeat(201) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    const message = await screen.findByText(
      'Enter a model ID of up to 200 characters, not a tier name',
    );
    expect(fast.getAttribute('aria-invalid')).toBe('true');
    expect(fast.getAttribute('aria-describedby')).toContain(message.id);
    expect(
      screen.getByRole('textbox', { name: 'Balanced model' }).getAttribute('aria-invalid'),
    ).toBe(null);
    expect(patches).toEqual([]);
  });
});
