import type { BatchDto } from '@10db/contracts';
import { Badge, Code, Group, Paper, Stack, Text } from '@mantine/core';
import { BATCH_COLORS, BATCH_LABELS } from './batch-labels';
import { PullRequestLink } from './pull-request-link';

/** Every batch of the project, newest first, so a shipped batch's pull request stays one click away. */
export function BatchHistory({ batches }: { readonly batches: readonly BatchDto[] }) {
  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Text size="sm" fw={600}>
          Batches
        </Text>
        <Stack gap={4} role="list" aria-label="Batches">
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
      </Stack>
    </Paper>
  );
}
