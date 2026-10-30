import { CARD_RESOLUTION, CardResolution, type InboxItemDto } from '@10db/contracts';
import { Alert, Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { useResolvedInbox } from '../../daemon/queries';
import { KIND_LABELS } from './permission-labels';

/** The most recent resolved cards shown; the list only grows. */
const SHOWN = 100;

/** How the card was closed, in words: 10db's reason, the builder's answer, or just that it is done. */
function resolvedHow(item: InboxItemDto): string {
  // The detail is JSON read back from the daemon: a boundary, so parse it.
  const resolution = CardResolution.safeParse(item.detail?.[CARD_RESOLUTION]);
  if (resolution.success) return `Resolved by 10db: ${resolution.data.reason}`;
  if (item.answer) return `Answered: ${item.answer.choice}`;
  return 'Resolved';
}

/** The inbox's resolved view: cards that were answered, dismissed, or closed by 10db, newest first. */
export function ResolvedInbox() {
  const resolved = useResolvedInbox();
  const items = [...(resolved.data ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, SHOWN);
  return (
    <Stack gap="xs">
      {resolved.isError ? (
        <Alert color="red" title="Couldn't load the resolved cards">
          {resolved.error.message}
        </Alert>
      ) : null}
      {resolved.isSuccess && items.length === 0 ? (
        <Text c="dimmed">Nothing has been resolved yet.</Text>
      ) : null}
      {items.map((item) => (
        <Paper key={item.id} withBorder p="sm" data-testid="resolved-card">
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <Badge size="sm" variant="light" color="gray" style={{ flexShrink: 0 }}>
              {KIND_LABELS[item.kind]}
            </Badge>
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Text size="sm" lineClamp={2} title={item.title}>
                {item.title}
              </Text>
              <Text size="xs" c="dimmed">
                {resolvedHow(item)}
              </Text>
            </Stack>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}
