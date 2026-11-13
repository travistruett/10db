import type { InboxItemDto } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import { useNow } from '../../shell/relative';
import { WaitingRow } from './waiting-row';

/** The questions out with other people: nothing here needs the builder. */
export function WaitingInbox({ items }: { readonly items: readonly InboxItemDto[] }) {
  const now = useNow();
  if (items.length === 0) return <Text c="dimmed">Nothing is out with anyone.</Text>;
  return (
    <Stack gap="xs">
      {items.map((item) => (
        <WaitingRow key={item.id} item={item} now={now} />
      ))}
    </Stack>
  );
}
