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
  modelRowDto({ model: 'small', name: 'Small', tier: 'fast', availableOn: [account.id] }),
  modelRowDto({ model: 'mid', name: 'Mid', tier: 'balanced', availableOn: [account.id] }),
  modelRowDto({ model: 'large', name: 'Large', tier: 'strongest', availableOn: [account.id] }),
  modelRowDto({ model: 'elsewhere', name: 'Elsewhere', tier: 'fast', availableOn: [OTHER] }),
  modelRowDto({
    model: 'old',
    name: 'Old',
    tier: 'fast',
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
          ? ['small', 'mid', 'large', 'old'].map((model) =>
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
  it('lists, for each tier, Automatic and only the models the account offers, grouped by tier', async () => {
    const account = gateway();
    serve(account, true);
    renderWithDaemon(<EditAccountForm account={account} />);
    for (const label of ['Fast model', 'Balanced model', 'Strongest model']) {
      fireEvent.click(await screen.findByRole('combobox', { name: label }));
      const list = within(await screen.findByRole('listbox', { name: label, hidden: true }));
      await waitFor(() => {
        expect(list.getAllByRole('option', { hidden: true }).map((o) => o.textContent)).toEqual([
          'Automatic',
          'Small',
          'Mid',
          'Large',
        ]);
      });
      fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'Escape' });
    }
  });

  it('saves a chosen model as that tier’s override, and Automatic takes it away again', async () => {
    const account = gateway({ strongest: 'large' });
    const patches = serve(account, true);
    renderWithDaemon(<EditAccountForm account={account} />);
    await choose('Fast model', 'Small');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(patches).toEqual([
        {
          settings: {
            baseUrl: 'https://gw.example.com/v1',
            tierOverrides: { fast: 'small', strongest: 'large' },
          },
        },
      ]);
    });
    await choose('Strongest model', 'Automatic');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(patches[1]).toEqual({
        settings: {
          baseUrl: 'https://gw.example.com/v1',
          tierOverrides: { fast: 'small' },
        },
      });
    });
  });

  it('keeps a saved override the account no longer offers on show, marked, so the field is never blank', async () => {
    const account = gateway({ fast: 'retired-one' });
    serve(account, true);
    renderWithDaemon(<EditAccountForm account={account} />);
    const fast = await screen.findByRole('combobox', { name: 'Fast model' });
    await waitFor(() => {
      expect(fast).toHaveProperty('value', 'retired-one (not offered)');
    });
  });

  it('gives a gateway that reports no list a text field per tier and saves what is typed', async () => {
    const account = gateway();
    const patches = serve(account, false);
    renderWithDaemon(<EditAccountForm account={account} />);
    const fast = await screen.findByRole('textbox', { name: 'Fast model' });
    expect(screen.queryByRole('combobox', { name: 'Fast model' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Balanced model' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Strongest model' })).toBeTruthy();
    fireEvent.change(fast, { target: { value: 'vendor/small' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(patches).toEqual([
        {
          settings: {
            baseUrl: 'https://gw.example.com/v1',
            tierOverrides: { fast: 'vendor/small' },
          },
        },
      ]);
    });
  });
});
