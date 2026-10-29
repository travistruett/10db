import {
  BatchFailure,
  BatchState,
  isSettled,
  latestPerTask,
  shipReadiness,
  ShipReadiness,
  WorkspaceMode,
  type BatchDto,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useAbandonBatch, useShipBatch } from '../../daemon/queries';
import { StateBadge } from '../factory/state-badge';
import { BATCH_COLORS, BATCH_LABELS } from './batch-labels';
import { AddFixTask } from './batch/add-fix-task';
import { PullRequestLink } from './pull-request-link';

const B = BatchState;

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
  workspaceMode = WorkspaceMode.Shared,
}: {
  readonly batch: BatchDto;
  readonly workstreams: readonly WorkstreamDto[];
  readonly workspaceMode?: WorkspaceMode;
}) {
  const ship = useShipBatch();
  const abandon = useAbandonBatch();
  const members = latestPerTask(workstreams.filter((w) => w.batchId === batch.id));
  const blocking = members.filter((w) => !isSettled(w.state));
  const readiness = shipReadiness(members.map((w) => w.state));
  const canShipAnyway = batch.state === B.Open && readiness === ShipReadiness.ShipAnyway;
  const canAbandon = batch.state === B.Open || batch.state === B.Failed;
  const canAddFix = workspaceMode === WorkspaceMode.Worktree && canAbandon;
  const [fixOpen, fix] = useDisclosure(false);
  const error = ship.error ?? abandon.error;
  // Each action clears the other's error first, so the strip shows only the latest action's refusal.
  const shipBatch = () => {
    abandon.reset();
    ship.mutate(batch.id);
  };
  const abandonBatch = () => {
    ship.reset();
    abandon.mutate(batch.id);
  };

  const compact = workspaceMode === WorkspaceMode.Worktree;
  const path = batch.worktreePath;
  const copyWorktree = path ? (
    <CopyButton value={path}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copied' : `Copy worktree path: ${path}`} withArrow>
          <ActionIcon
            size="sm"
            variant="subtle"
            color={copied ? 'teal' : 'gray'}
            aria-label="Copy worktree path"
            onClick={copy}
          >
            {copied ? <IconCheck size={16} stroke={1.5} /> : <IconCopy size={16} stroke={1.5} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  ) : null;

  const actions =
    batch.state === B.Failed || canShipAnyway || canAbandon || canAddFix ? (
      <Group gap="xs">
        {batch.state === B.Failed ? (
          <Button size="xs" loading={ship.isPending} onClick={shipBatch}>
            Retry
          </Button>
        ) : null}
        {canShipAnyway ? (
          <Button size="xs" variant="light" loading={ship.isPending} onClick={shipBatch}>
            Ship anyway
          </Button>
        ) : null}
        {canAddFix ? (
          <Button size="xs" variant="light" onClick={fix.open}>
            Add a fix task
          </Button>
        ) : null}
        {canAbandon ? (
          <Button
            size="xs"
            variant="default"
            color="red"
            loading={abandon.isPending}
            onClick={abandonBatch}
          >
            Abandon
          </Button>
        ) : null}
      </Group>
    ) : null;

  return (
    <Paper withBorder p={compact ? 'xs' : 'sm'}>
      <Stack gap="xs">
        <Group gap="sm" wrap="wrap">
          <Text fw={600}>{batch.title}</Text>
          <Badge color={BATCH_COLORS[batch.state]} variant="light" size="sm">
            {BATCH_LABELS[batch.state]}
          </Badge>
          {batch.branch ? <Code>{batch.branch}</Code> : null}
          {batch.prUrl ? <PullRequestLink url={batch.prUrl} /> : null}
          {compact ? copyWorktree : null}
          {compact ? <Group ml="auto">{actions}</Group> : null}
          {compact && blocking.length > 0 ? (
            <Text size="xs" c="dimmed">
              {`${String(blocking.length)} unsettled`}
            </Text>
          ) : null}
        </Group>
        {batch.worktreePath && !compact ? (
          <Group gap="xs" wrap="nowrap">
            <Code style={{ wordBreak: 'break-all' }}>{batch.worktreePath}</Code>
            {copyWorktree}
          </Group>
        ) : null}
        {batch.failure ? (
          <Text size="sm" c="red">
            {FAILURE_LABELS[batch.failure]}
          </Text>
        ) : null}
        {blocking.length > 0 && !compact ? (
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
        {compact ? null : actions}
      </Stack>
      {canAddFix ? (
        <AddFixTask batch={batch} workstreams={workstreams} opened={fixOpen} onClose={fix.close} />
      ) : null}
    </Paper>
  );
}
