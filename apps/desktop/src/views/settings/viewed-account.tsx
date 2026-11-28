import type { AccountDto, AccountId } from '@10db/contracts';
import { Select, Text } from '@mantine/core';
import { useSyncExternalStore } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { ControlSize } from '../../shell/control-size';

const ACCOUNT_LABEL = (
  <Text size="xs" c="dimmed">
    Account
  </Text>
);

// The account the Playbook and Language Models read, kept here so both pages show the same one.
let chosen: AccountId | null = null;
const listeners = new Set<() => void>();

function choose(next: AccountId): void {
  chosen = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface ViewedAccount {
  readonly accounts: ReturnType<typeof useAccounts>;
  /** The accounts that can be picked: every one not archived. */
  readonly live: readonly AccountDto[];
  /** The one chosen, else the default, else the first live one; null with no live account. */
  readonly account: AccountDto | null;
  readonly choose: (id: AccountId) => void;
}

/** The account the Playbook and Language Models resolve models on, shared by both pages. */
export function useViewedAccount(): ViewedAccount {
  const accounts = useAccounts();
  const picked = useSyncExternalStore(subscribe, () => chosen);
  const live = (accounts.data ?? []).filter((a) => !a.archived);
  const account =
    live.find((a) => a.id === picked) ?? live.find((a) => a.isDefault) ?? live[0] ?? null;
  return { accounts, live, account, choose };
}

/** The Account select of the Playbook and Language Models pages. */
export function ViewedAccountSelect({
  viewed,
  width = 240,
}: {
  readonly viewed: ViewedAccount;
  /** Narrower where it shares a row with a page's tabs. */
  readonly width?: number;
}) {
  const { accounts, live, account } = viewed;
  return (
    <Select
      aria-label="Account"
      size={ControlSize.Toolbar}
      w={width}
      leftSection={ACCOUNT_LABEL}
      leftSectionWidth={72}
      leftSectionPointerEvents="none"
      allowDeselect={false}
      data={live.map((a) => ({ value: a.id, label: a.label }))}
      value={account?.id ?? null}
      placeholder={accounts.isPending ? 'Reading accounts…' : 'No account'}
      disabled={live.length === 0}
      onChange={(value) => {
        const next = live.find((a) => a.id === value);
        if (next) viewed.choose(next.id);
      }}
    />
  );
}
