import { Badge, Group, Text } from '@mantine/core';
import type { AnchorStatus } from './anchor-status';

/**
 * One anchor check's word in its color, then where and when it read as text. A badge of a fact that no
 * longer stands is dimmed: its last check says nothing about the claim that replaced it.
 */
export function AnchorBadge({
  status,
  task = null,
  note = null,
  dimmed = false,
}: {
  readonly status: AnchorStatus;
  /** The task whose check it is, named when a fact can have several. */
  readonly task?: string | null;
  /** A word on the check itself, as "checked by an earlier run". */
  readonly note?: string | null;
  readonly dimmed?: boolean;
}) {
  const detail = [status.detail, note].filter((part) => part !== null).join(' · ');
  return (
    <Group gap={6} wrap="nowrap">
      {task === null ? null : (
        <Text size="xs" truncate>
          {task}
        </Text>
      )}
      <Badge
        size="sm"
        variant={dimmed ? 'outline' : 'light'}
        color={dimmed ? 'gray' : status.color}
        style={{ flex: 'none' }}
      >
        {status.label}
      </Badge>
      {detail === '' ? null : (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {detail}
        </Text>
      )}
    </Group>
  );
}
