import { Button, Group, List, Text } from '@mantine/core';
import { useState } from 'react';
import { FOLD_AT, type SwitchItem } from './preview-items';

/** One item: what comes along, or what was left out with its reason. */
function ItemLine({ item }: { readonly item: SwitchItem }) {
  return (
    <List.Item>
      <Text component="span" size="xs" {...(item.why === null ? {} : { c: 'dimmed' })}>
        {item.what}
      </Text>
      {item.why === null ? null : (
        <Text component="span" size="xs" c="dimmed">
          {` · left out: ${item.why}`}
        </Text>
      )}
    </List.Item>
  );
}

/** The items under a switch, folded past `FOLD_AT` with a control to show the rest. */
export function SwitchItems({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly SwitchItem[];
}) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, FOLD_AT);
  return (
    <>
      <List size="xs" spacing={2} aria-label={`${label} items`}>
        {shown.map((item) => (
          <ItemLine key={`${item.what} ${item.why ?? ''}`} item={item} />
        ))}
      </List>
      {items.length > FOLD_AT ? (
        <Button
          variant="subtle"
          size="compact-xs"
          aria-expanded={all}
          aria-label={`${all ? 'Hide' : 'Show'} all ${String(items.length)} ${label} items`}
          onClick={() => {
            setAll(!all);
          }}
        >
          {all ? 'Show fewer' : `Show ${String(items.length - FOLD_AT)} more`}
        </Button>
      ) : null}
    </>
  );
}

/** What no switch owns, and one quiet line counting what was left out as expected, with Show. */
export function OtherAndExpected({
  other,
  expected,
}: {
  readonly other: readonly SwitchItem[];
  readonly expected: readonly SwitchItem[];
}) {
  const [open, setOpen] = useState(false);
  if (other.length === 0 && expected.length === 0) return null;
  return (
    <>
      {other.length === 0 ? null : (
        <>
          <Text size="sm" fw={500}>
            Other
          </Text>
          <SwitchItems label="Other" items={other} />
        </>
      )}
      {expected.length === 0 ? null : (
        <>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {`${String(expected.length)} more left out as expected`}
            </Text>
            <Button
              variant="subtle"
              size="compact-xs"
              aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} left out as expected`}
              onClick={() => {
                setOpen(!open);
              }}
            >
              {open ? 'Hide' : 'Show'}
            </Button>
          </Group>
          {open ? (
            <List size="xs" spacing={2} aria-label="Left out as expected">
              {expected.map((item) => (
                <ItemLine key={`${item.what} ${item.why ?? ''}`} item={item} />
              ))}
            </List>
          ) : null}
        </>
      )}
    </>
  );
}
