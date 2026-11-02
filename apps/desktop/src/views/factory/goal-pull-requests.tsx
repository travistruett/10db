import type { BatchDto } from '@10db/contracts';
import { Alert, Badge, Code, Group, Stack, Text, Title } from '@mantine/core';
import { BATCH_COLORS, BATCH_LABELS } from '../board/batch-labels';
import { PullRequestLink } from '../board/pull-request-link';

export interface GoalPullRequestsProps {
  /** The batches the goal's tasks ran in, newest first. */
  readonly batches: readonly BatchDto[];
  readonly error: string | null;
}

/** A goal's pull requests: its batches with their state, branch and pull request. */
export function GoalPullRequests({ batches, error }: GoalPullRequestsProps) {
  return (
    <Stack gap="xs">
      <Title order={3} size="h5">
        Pull requests
      </Title>
      {error ? (
        <Alert color="red" title="Couldn't load the pull requests">
          {error}
        </Alert>
      ) : null}
      {error === null && batches.length === 0 ? (
        <Text size="sm" c="dimmed">
          None
        </Text>
      ) : null}
      {batches.length > 0 ? (
        <Stack gap={4} role="list" aria-label="Pull requests">
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
      ) : null}
    </Stack>
  );
}
