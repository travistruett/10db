import type { InboxItemDto } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import { ResolvedDetail } from './resolved-detail';

/** The content for a Resolved row: its title and how it closed. */
export function ResolvedContent({ item }: { readonly item: InboxItemDto }) {
  return (
    <Stack gap="sm">
      <Text fw={600}>{item.title}</Text>
      <ResolvedDetail item={item} />
    </Stack>
  );
}
