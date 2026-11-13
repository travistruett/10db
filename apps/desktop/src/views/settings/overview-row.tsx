import { Box, Button, Group, Skeleton, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { ConnectionStatus, ConnectionTone } from './connection-status';
import { useFocusTarget } from './focus-target';
import type { OverviewRow } from './overview-rows';
import { RowMarkIcon } from './row-mark';

const MARK_SIZE = 16;
const ROW_HEIGHT = 52;

/** The mark and the name: the left of every row. */
function Name({ row }: { readonly row: OverviewRow }) {
  return (
    <Group gap="sm" wrap="nowrap" w={200} style={{ flex: 'none' }}>
      <RowMarkIcon mark={row.mark} />
      <Text size="sm" fw={500} truncate>
        {row.name}
      </Text>
    </Group>
  );
}

/** One connection: the mark, the name, its state and a dimmed second line; the whole row is the link that fixes it. */
export function OverviewRowView({ row }: { readonly row: OverviewRow }) {
  const { ref } = useFocusTarget<HTMLDivElement>(row.id);
  const state = row.state;
  if (state.kind === 'loading') return <Skeleton height={ROW_HEIGHT} radius={0} />;
  if (state.kind === 'failed')
    return (
      <Group ref={ref} px="md" py="sm" gap="md" wrap="nowrap" mih={ROW_HEIGHT}>
        <Name row={row} />
        <Box style={{ flex: 1 }} miw={0}>
          <ConnectionStatus tone={ConnectionTone.NeedsYou} label="Couldn't read this" />
        </Box>
        <Button
          size="compact-xs"
          variant="default"
          aria-label={`Retry ${row.name}`}
          onClick={() => {
            row.retry?.();
          }}
        >
          Retry
        </Button>
      </Group>
    );
  const search = row.link.focus === null ? {} : { focus: row.link.focus };
  return (
    <Box ref={ref}>
      <UnstyledButton
        display="block"
        w="100%"
        px="md"
        py="sm"
        mih={ROW_HEIGHT}
        renderRoot={(props) => (
          <Link
            {...props}
            to="/settings/$section"
            params={{ section: row.link.section }}
            search={search}
          />
        )}
      >
        <Group gap="md" wrap="nowrap" align="flex-start">
          <Name row={row} />
          <Stack gap={2} style={{ flex: 1 }} miw={0}>
            <ConnectionStatus tone={state.tone} label={state.label} />
            {state.detail === null ? null : (
              <Text size="xs" c="dimmed">
                {state.detail}
              </Text>
            )}
          </Stack>
          <IconChevronRight size={MARK_SIZE} aria-hidden style={{ flex: 'none' }} />
        </Group>
      </UnstyledButton>
    </Box>
  );
}
