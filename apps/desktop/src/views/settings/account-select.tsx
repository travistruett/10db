import type { AccountDto } from '@10db/contracts';
import { Group, Select, Stack, Text, type SelectProps } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { ACCOUNT_KIND_LABEL } from './account-kind-label';

/** The line under an account's name: who it signs in as, and what kind of account it is. */
function byline(account: AccountDto): string {
  const kind = ACCOUNT_KIND_LABEL[account.kind];
  return account.expectedIdentity === null ? kind : `${account.expectedIdentity} · ${kind}`;
}

export interface AccountSelectProps extends Omit<SelectProps, 'data' | 'renderOption'> {
  /** The accounts to offer; archived ones are left out. */
  readonly accounts: readonly AccountDto[];
}

/**
 * An account picker: the field shows the account's name, and each option adds a byline with its
 * identity and kind, so a long email never crowds the name.
 */
export function AccountSelect({ accounts, ...props }: AccountSelectProps) {
  const offered = accounts.filter((a) => !a.archived);
  // Keyed by plain string: the option value Mantine hands back is unbranded.
  const byId = new Map<string, AccountDto>(offered.map((a) => [a.id, a]));
  return (
    <Select
      {...props}
      data={offered.map((a) => ({ value: a.id, label: a.label }))}
      renderOption={({ option, checked }) => {
        const account = byId.get(option.value);
        return (
          <Group wrap="nowrap" justify="space-between" gap="sm" w="100%">
            <Stack gap={0} miw={0}>
              <Text size="sm">{option.label}</Text>
              {account ? (
                <Text size="xs" c="dimmed" truncate>
                  {byline(account)}
                </Text>
              ) : null}
            </Stack>
            {checked === true ? (
              <IconCheck size={14} stroke={1.5} style={{ flex: 'none' }} />
            ) : null}
          </Group>
        );
      }}
    />
  );
}
