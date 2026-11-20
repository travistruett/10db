import { Select, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';

// The filters the Record's tables hold in their headers: a search in the first column, and a choice
// (a state, a kind, a document) in the column it narrows. The daemon applies both.

/** The empty choice every filter starts on. */
export const ANY = '';

export function SearchFilter({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
}) {
  return (
    <TextInput
      aria-label="Search"
      placeholder="Search"
      size="xs"
      w={240}
      data-autofocus
      maxLength={200}
      leftSection={<IconSearch size={14} stroke={1.5} />}
      value={value}
      onChange={(e) => {
        onChange(e.currentTarget.value.slice(0, 200));
      }}
    />
  );
}

export function ChoiceFilter({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (next: string) => void;
}) {
  return (
    <Select
      aria-label={label}
      size="xs"
      w={200}
      allowDeselect={false}
      checkIconPosition="right"
      // Inside the filter's popover: a dropdown in a portal would count as a click outside and close it.
      comboboxProps={{ withinPortal: false }}
      data={[{ value: ANY, label: `Any ${label}` }, ...options]}
      value={value}
      onChange={(next) => {
        onChange(next ?? ANY);
      }}
    />
  );
}
