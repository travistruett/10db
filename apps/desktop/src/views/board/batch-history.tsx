import type { BatchDto } from '@10db/contracts';
import { Badge, Button, Code, Collapse, Group, Paper, Stack, Text } from '@mantine/core';
import { useDisclosure, useId } from '@mantine/hooks';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { BATCH_COLORS, BATCH_LABELS } from './batch-labels';
import { PullRequestLink } from './pull-request-link';

/** Batches with no strip of their own, newest first, so a shipped batch's pull request stays one click away. Collapsed until opened. */
export function BatchHistory({ batches }: { readonly batches: readonly BatchDto[] }) {
  const [opened, { toggle }] = useDisclosure(false);
  const listId = useId();
  return (
    <Paper withBorder px="sm" py={4}>
      <Button
        variant="subtle"
        color="gray"
        size="compact-sm"
        aria-expanded={opened}
        aria-controls={listId}
        leftSection={
          opened ? (
            <IconChevronDown size={16} stroke={1.5} />
          ) : (
            <IconChevronRight size={16} stroke={1.5} />
          )
        }
        onClick={toggle}
      >
        {`Batches (${String(batches.length)})`}
      </Button>
      <Collapse expanded={opened} id={listId}>
        <Stack gap={4} role="list" aria-label="Batches" pt="xs">
          {batches.map((batch) => (
            <Group key={batch.id} gap="sm" wrap="wrap" role="listitem" aria-label={batch.title}>
              <Text size="sm">{batch.title}</Text>
              <Badge color={BATCH_COLORS[batch.state]} variant="light" size="sm">
                {BATCH_LABELS[batch.state]}
              </Badge>
              {batch.branch ? <Code>{batch.branch}</Code> : null}
              {batch.prUrl ? <PullRequestLink url={batch.prUrl} /> : null}
            </Group>
          ))}
        </Stack>
      </Collapse>
    </Paper>
  );
}
