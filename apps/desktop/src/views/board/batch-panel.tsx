import {
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
  Anchor,
  Button,
  Code,
  CopyButton,
  Group,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useAbandonBatch, useShipBatch } from '../../daemon/queries';
import { FAILURE_LABELS } from './batch-labels';
import { abandonNote } from './batch/abandon-note';
import { AddFixTask } from './batch/add-fix-task';
import { PullRequestLink } from './pull-request-link';

const B = BatchState;

export interface BatchPanelProps {
  readonly batch: BatchDto;
  /** Every workstream, so the batch's members decide whether it can ship anyway. */
  readonly workstreams: readonly WorkstreamDto[];
  readonly workspaceMode: WorkspaceMode;
  /** The project's gate command, named beside a failed gate's exit code. */
  readonly gateCommand: string | null;
}

/** Where a task's work ships: its branch, its pull request, why a ship failed and what the builder can do about it. */
export function BatchPanel({ batch, workstreams, workspaceMode, gateCommand }: BatchPanelProps) {
  const ship = useShipBatch();
  const abandon = useAbandonBatch();
  const [fixOpen, fix] = useDisclosure(false);
  const members = latestPerTask(workstreams.filter((w) => w.batchId === batch.id));
  const readiness = shipReadiness(members.map((w) => w.state));
  const failed = batch.state === B.Failed;
  const canShipAnyway =
    batch.state === B.Open &&
    readiness === ShipReadiness.ShipAnyway &&
    members.some((w) => !isSettled(w.state));
  const canAbandon = batch.state === B.Open || failed;
  const canAddFix = workspaceMode === WorkspaceMode.Worktree && canAbandon;
  const note = abandonNote(batch, workstreams);
  const error = ship.error ?? abandon.error;
  // Each action clears the other's error first, so the panel shows only the latest action's refusal.
  const shipBatch = () => {
    abandon.reset();
    ship.mutate(batch.id);
  };
  const abandonBatch = () => {
    ship.reset();
    abandon.mutate(batch.id);
  };
  const path = batch.worktreePath;
  const exit = batch.gateExitCode;

  return (
    <Stack gap="xs" aria-label="Delivery" role="group">
      <Group gap="sm" wrap="wrap">
        {batch.branch ? <Code>{batch.branch}</Code> : null}
        {batch.prUrl ? <PullRequestLink url={batch.prUrl} /> : null}
        {path ? (
          <CopyButton value={path}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : `Copy worktree path: ${path}`} withArrow>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color={copied ? 'green' : 'gray'}
                  aria-label="Copy worktree path"
                  onClick={copy}
                >
                  {copied ? (
                    <IconCheck size={16} stroke={1.5} />
                  ) : (
                    <IconCopy size={16} stroke={1.5} />
                  )}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        ) : null}
      </Group>
      {batch.failure ? (
        <Stack gap={2}>
          <Text size="sm" c="red">
            {`Not shipped: ${FAILURE_LABELS[batch.failure].charAt(0).toLowerCase()}${FAILURE_LABELS[batch.failure].slice(1)}`}
          </Text>
          {exit !== null && gateCommand ? (
            <Text size="xs" c="dimmed">{`${gateCommand} exited with code ${String(exit)}`}</Text>
          ) : null}
          {batch.gateLogPath ? (
            <Anchor size="xs" href={`file://${batch.gateLogPath}`} title={batch.gateLogPath}>
              Gate log
            </Anchor>
          ) : null}
        </Stack>
      ) : null}
      {failed || canShipAnyway || canAddFix || canAbandon ? (
        <Group gap="xs">
          {failed ? (
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
              disabled={note.refusal !== null}
              onClick={abandonBatch}
            >
              Abandon
            </Button>
          ) : null}
        </Group>
      ) : null}
      {canAbandon ? (
        <Text size="xs" c="dimmed">
          {note.line}
        </Text>
      ) : null}
      {error ? (
        <Alert color="red" variant="light">
          {error.message}
        </Alert>
      ) : null}
      {canAddFix ? (
        <AddFixTask batch={batch} workstreams={workstreams} opened={fixOpen} onClose={fix.close} />
      ) : null}
    </Stack>
  );
}
