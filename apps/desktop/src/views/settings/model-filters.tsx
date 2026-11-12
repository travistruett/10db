import { AccountId, ModelTier, type AccountDto } from '@10db/contracts';
import { Checkbox, Select, Stack, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { TIER_LABEL } from './model-labels';
import type { ModelFilter } from './model-order';

const ANY_ACCOUNT = 'any-account';

const isTier = (value: string): value is ModelTier =>
  Object.values(ModelTier).some((t) => t === value);

interface FilterProps {
  readonly filter: ModelFilter;
  readonly onFilter: (next: ModelFilter) => void;
}

/** The Model column's filter: a search over names and model IDs. */
export function ModelSearchFilter({ filter, onFilter }: FilterProps) {
  return (
    <TextInput
      aria-label="Search models"
      placeholder="Name or model ID"
      size="xs"
      w={240}
      data-autofocus
      leftSection={<IconSearch size={14} stroke={1.5} />}
      value={filter.query}
      onChange={(e) => {
        onFilter({ ...filter, query: e.currentTarget.value });
      }}
    />
  );
}

/** The Tier column's filter: any of the tiers; none ticked keeps every model. */
export function TierFilter({ filter, onFilter }: FilterProps) {
  return (
    <Checkbox.Group
      label="Tier"
      value={[...filter.tiers]}
      onChange={(next) => {
        onFilter({ ...filter, tiers: next.filter(isTier) });
      }}
    >
      <Stack gap="xs" mt="xs">
        {Object.values(ModelTier).map((tier) => (
          <Checkbox key={tier} size="xs" value={tier} label={TIER_LABEL[tier]} />
        ))}
      </Stack>
    </Checkbox.Group>
  );
}

/** The Available on column's filter: one account's models, or every account's. */
export function AccountFilter({
  filter,
  onFilter,
  accounts,
}: FilterProps & { readonly accounts: readonly AccountDto[] }) {
  return (
    <Select
      aria-label="Account"
      size="xs"
      w={220}
      allowDeselect={false}
      checkIconPosition="right"
      // Inside the filter's popover: a dropdown in a portal would count as a click outside and close it.
      comboboxProps={{ withinPortal: false }}
      value={filter.accountId ?? ANY_ACCOUNT}
      data={[
        { value: ANY_ACCOUNT, label: 'Any account' },
        ...accounts.map((a) => ({ value: a.id, label: a.label })),
      ]}
      onChange={(value) => {
        const parsed = AccountId.safeParse(value);
        onFilter({ ...filter, accountId: parsed.success ? parsed.data : null });
      }}
    />
  );
}
