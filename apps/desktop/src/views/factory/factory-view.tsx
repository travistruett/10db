import type { WorkstreamId } from '@10db/contracts';
import {
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Switch,
  Table,
  Text,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import { useState } from 'react';
import { useCancelWorkstream, useRetryWorkstream, useWorkstreams } from '../../daemon/queries';
import { BenchmarkSyncNote } from './benchmark-sync-note';
import { ContextGauge } from './context-gauge';
import { RelativeTime } from './relative-time';
import { StateBadge } from './state-badge';
import { StepCell } from './step-cell';
import { canCancel, canRetry } from './workstream-state';

export function FactoryView() {
  const [showFinished, setShowFinished] = useState(false);
  const workstreams = useWorkstreams({ active: !showFinished });
  const cancel = useCancelWorkstream();
  const retry = useRetryWorkstream();
  const [confirming, setConfirming] = useState<WorkstreamId | null>(null);
  const rows = workstreams.data ?? [];
  const confirmingRow = rows.find((ws) => ws.id === confirming);

  return (
    <Stack>
      <Group justify="space-between">
        <Group gap="md">
          <Title order={2}>Factory</Title>
          <BenchmarkSyncNote />
        </Group>
        <Switch
          label="Show finished"
          checked={showFinished}
          onChange={(e) => {
            setShowFinished(e.currentTarget.checked);
          }}
        />
      </Group>
      {workstreams.isError ? (
        <Alert color="red" title="Couldn't load the workstreams">
          {workstreams.error.message}
        </Alert>
      ) : null}
      {retry.error ? (
        <Alert color="red" title="The daemon refused that">
          {retry.error.message}
        </Alert>
      ) : null}
      {workstreams.isPending ? <Loader size="sm" aria-label="Loading workstreams" /> : null}
      {workstreams.isSuccess && rows.length === 0 ? (
        <Text c="dimmed">
          {showFinished ? 'No workstreams yet.' : 'No workstreams are running.'}
        </Text>
      ) : null}
      {rows.length > 0 ? (
        <Table highlightOnHover verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Task</Table.Th>
              <Table.Th>State</Table.Th>
              <Table.Th>Step</Table.Th>
              <Table.Th>Context</Table.Th>
              <Table.Th>Sessions</Table.Th>
              <Table.Th>Last activity</Table.Th>
              <Table.Th>
                <VisuallyHidden>Actions</VisuallyHidden>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((ws) => (
              <Table.Tr key={ws.id}>
                <Table.Td>
                  <Text size="sm">{ws.taskTitle}</Text>
                  {ws.failureReason ? (
                    <Text size="xs" c="red">
                      {ws.failureReason}
                    </Text>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  <StateBadge state={ws.state} />
                </Table.Td>
                <Table.Td>
                  <StepCell workstream={ws} />
                </Table.Td>
                <Table.Td>
                  <ContextGauge pct={ws.contextPct} />
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{ws.sessionCount}</Text>
                </Table.Td>
                <Table.Td>
                  <RelativeTime at={ws.lastActivityAt} />
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end" wrap="nowrap">
                    {canRetry(ws.state) ? (
                      <Button
                        size="xs"
                        variant="light"
                        loading={retry.isPending && retry.variables === ws.id}
                        onClick={() => {
                          retry.mutate(ws.id);
                        }}
                      >
                        Retry
                      </Button>
                    ) : null}
                    {canCancel(ws.state) ? (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        onClick={() => {
                          setConfirming(ws.id);
                        }}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : null}

      <Modal
        opened={confirming !== null}
        onClose={() => {
          setConfirming(null);
          cancel.reset();
        }}
        title="Cancel this workstream?"
      >
        <Stack>
          <Text size="sm">
            The session stops and its claims are released.{' '}
            {confirmingRow ? `Task: ${confirmingRow.taskTitle}` : ''}
          </Text>
          {cancel.error ? (
            <Alert color="red" title="The daemon refused that">
              {cancel.error.message}
            </Alert>
          ) : null}
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setConfirming(null);
                cancel.reset();
              }}
            >
              Keep running
            </Button>
            <Button
              color="red"
              loading={cancel.isPending && cancel.variables === confirming}
              onClick={() => {
                if (!confirming) return;
                cancel.mutate(confirming, {
                  onSuccess: () => {
                    setConfirming(null);
                  },
                });
              }}
            >
              Cancel workstream
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
