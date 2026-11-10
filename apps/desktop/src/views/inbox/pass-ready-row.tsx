import type { InboxItemDto } from '@10db/contracts';
import { Badge, Group, List, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { ProjectLabel } from '../../shell/project-label';
import { SELECTED_CARD_ATTRIBUTE } from './use-inbox-keys';

export interface PassReadyRowProps {
  /** The pass's Ready items, one per page, oldest first. */
  readonly items: readonly [InboxItemDto, ...InboxItemDto[]];
  readonly selected: boolean;
  readonly onSelect: () => void;
}

/** "Workbench: 3 pages ready". */
export function passReadyTitle(count: number): string {
  return `Workbench: ${String(count)} ${count === 1 ? 'page' : 'pages'} ready`;
}

/**
 * A Workbench pass's Ready pages as one row (spec §6.1): it names each page and is answered by
 * nothing here. A page is never approved or sent back; the builder looks at it and writes again.
 */
export function PassReadyRow({ items, selected, onSelect }: PassReadyRowProps) {
  const [first] = items;
  const header = (
    <Group gap="sm" wrap="nowrap">
      {/* Every card waits on the builder: yellow, never the red of a failure. */}
      <Badge size="sm" variant="light" color="yellow" style={{ flexShrink: 0 }}>
        Workbench
      </Badge>
      <ProjectLabel projectId={first.projectId} />
      <Text size="sm" fw={selected ? 600 : undefined} lineClamp={1} style={{ minWidth: 0 }}>
        {passReadyTitle(items.length)}
      </Text>
    </Group>
  );
  if (!selected)
    return (
      <UnstyledButton
        onClick={onSelect}
        p="sm"
        style={{
          borderRadius: 'var(--mantine-radius-md)',
          border: '1px solid var(--mantine-color-default-border)',
        }}
      >
        {header}
      </UnstyledButton>
    );
  return (
    <Paper withBorder p="md" shadow="xs" {...{ [SELECTED_CARD_ATTRIBUTE]: true }}>
      <Stack gap="sm">
        {header}
        {/* Item titles are written by the daemon from task titles: text only. */}
        <List size="sm" spacing={4}>
          {items.map((item) => (
            <List.Item key={item.id}>{item.title}</List.Item>
          ))}
        </List>
      </Stack>
    </Paper>
  );
}
