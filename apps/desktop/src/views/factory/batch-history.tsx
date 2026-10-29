import type { BatchDto } from '@10db/contracts';
import { Badge, Code, Group, Stack, Text, Title } from '@mantine/core';
import { BATCH_COLORS, BATCH_LABELS } from '../board/batch-labels';
import { PullRequestLink } from '../board/pull-request-link';

/** The project's batches, newest first, so a shipped batch's pull request stays one click away. */
export function BatchHistory({ batches }: { readonly batches: readonly BatchDto[] }) {
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        Batches
      </Title>
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
  );
}
