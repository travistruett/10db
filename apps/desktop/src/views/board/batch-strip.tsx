import {
  BatchFailure,
  BatchState,
  isSettled,
  latestPerTask,
  shipReadiness,
  ShipReadiness,
  type BatchDto,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Text,
  type MantineColor,
} from '@mantine/core';
import { useAbandonBatch, useShipBatch } from '../../daemon/queries';
import { StateBadge } from '../factory/state-badge';

const B = BatchState;

/** DESIGN.md status colors: blue in progress, red failed, green shipped, gray idle or over. */
const BATCH_COLORS: Readonly<Record<BatchState, MantineColor>> = {
  [B.Cutting]: 'blue',
  [B.Open]: 'blue',
  [B.Shipping]: 'blue',
  [B.Shipped]: 'green',
  [B.Closed]: 'gray',
  [B.Failed]: 'red',
  [B.Abandoned]: 'gray',
};

const BATCH_LABELS: Readonly<Record<BatchState, string>> = {
  [B.Cutting]: 'Cutting branch',
  [B.Open]: 'Open',
  [B.Shipping]: 'Shipping',
  [B.Shipped]: 'Shipped',
  [B.Closed]: 'Closed: no changes',
  [B.Failed]: 'Not shipped',
  [B.Abandoned]: 'Abandoned',
};

const FAILURE_LABELS: Readonly<Record<BatchFailure, string>> = {
  [BatchFailure.WrongBranch]: 'The checkout is not on the batch branch',
  [BatchFailure.DirtyCheckout]: 'The checkout has uncommitted changes',
  [BatchFailure.GateFailed]: 'The gate failed',
  [BatchFailure.GateTimedOut]: 'The gate timed out',
  [BatchFailure.PushRejected]: 'git push was rejected',
  [BatchFailure.GhUnavailable]: 'gh is missing or signed out',
  [BatchFailure.Network]: 'A network step failed',
};

/** The project's current batch: what it is, what holds it, and what the builder can do (batch delivery spec §8). */
export function BatchStrip({
  batch,
  workstreams,
}: {
  readonly batch: BatchDto;
  readonly workstreams: readonly WorkstreamDto[];
}) {
  const ship = useShipBatch();
  const abandon = useAbandonBatch();
  const members = latestPerTask(workstreams.filter((w) => w.batchId === batch.id));
  const blocking = members.filter((w) => !isSettled(w.state));
  const readiness = shipReadiness(members.map((w) => w.state));
  const canShipAnyway = batch.state === B.Open && readiness === ShipReadiness.ShipAnyway;
  const canAbandon = batch.state === B.Open || batch.state === B.Failed;
  const error = ship.error ?? abandon.error;

  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Group gap="sm" wrap="wrap">
          <Text fw={600}>{batch.title}</Text>
          <Badge color={BATCH_COLORS[batch.state]} variant="light" size="sm">
            {BATCH_LABELS[batch.state]}
          </Badge>
          {batch.branch ? <Code>{batch.branch}</Code> : null}
          {batch.prUrl ? (
            <Anchor href={batch.prUrl} target="_blank" rel="noreferrer" size="sm">
              Pull request
            </Anchor>
          ) : null}
        </Group>
        {batch.failure ? (
          <Text size="sm" c="red">
            {FAILURE_LABELS[batch.failure]}
          </Text>
        ) : null}
        {blocking.length > 0 ? (
          <Stack gap={4}>
            {blocking.map((w) => (
              <Group key={w.id} gap="xs">
                <Text size="sm">{w.taskTitle}</Text>
                <StateBadge state={w.state} />
              </Group>
            ))}
          </Stack>
        ) : null}
        {error ? (
          <Alert color="red" variant="light">
            {error.message}
          </Alert>
        ) : null}
        {batch.state === B.Failed || canShipAnyway || canAbandon ? (
          <Group gap="xs">
            {batch.state === B.Failed ? (
              <Button
                size="xs"
                loading={ship.isPending}
                onClick={() => {
                  ship.mutate(batch.id);
                }}
              >
                Retry
              </Button>
            ) : null}
            {canShipAnyway ? (
              <Button
                size="xs"
                variant="light"
                loading={ship.isPending}
                onClick={() => {
                  ship.mutate(batch.id);
                }}
              >
                Ship anyway
              </Button>
            ) : null}
            {canAbandon ? (
              <Button
                size="xs"
                variant="default"
                color="red"
                loading={abandon.isPending}
                onClick={() => {
                  abandon.mutate(batch.id);
                }}
              >
                Abandon
              </Button>
            ) : null}
          </Group>
        ) : null}
      </Stack>
    </Paper>
  );
}
