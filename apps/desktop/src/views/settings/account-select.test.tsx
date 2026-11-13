import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { accountDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { AccountSelect } from './account-select';
import { cantRunAgents } from './accounts/used-by';

const client = accountDto({ label: 'Client key', kind: 'anthropic_api_key' });
const archived = accountDto({ label: 'Old key', archived: true });

describe('AccountSelect', () => {
  it('shows the account name in the field and the email and kind as a byline', async () => {
    render(
      <MantineProvider>
        <AccountSelect
          aria-label="Account"
          accounts={[DEFAULT_ACCOUNT, client, archived]}
          value={DEFAULT_ACCOUNT.id}
          onChange={() => undefined}
        />
      </MantineProvider>,
    );
    const field = screen.getByRole('combobox', { name: 'Account' });
    expect(field).toHaveProperty('value', 'Claude plan');
    fireEvent.click(field);
    const options = await screen.findAllByRole('option', { hidden: true });
    expect(options.map((o) => o.textContent)).toEqual([
      'Claude planbuilder@example.com · Claude subscription',
      'Client keyAnthropic API key',
    ]);
  });

  it('lists an account its rule refuses disabled, with the reason in place of the byline', async () => {
    const router = accountDto({ label: 'Work key', kind: 'openrouter' });
    const picked: (string | null)[] = [];
    render(
      <MantineProvider>
        <AccountSelect
          aria-label="Account"
          accounts={[DEFAULT_ACCOUNT, router]}
          isDisabled={cantRunAgents}
          value={DEFAULT_ACCOUNT.id}
          onChange={(value) => {
            picked.push(value);
          }}
        />
      </MantineProvider>,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Account' }));
    const refused = await screen.findByRole('option', { name: /Work key/, hidden: true });
    expect(refused.textContent).toBe("Work keyCan't run agents yet");
    expect(refused.getAttribute('data-combobox-disabled')).toBe('true');
    fireEvent.click(refused);
    expect(picked).toEqual([]);
  });
});
