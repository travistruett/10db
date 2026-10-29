import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { accountDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { AccountSelect } from './account-select';

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
});
