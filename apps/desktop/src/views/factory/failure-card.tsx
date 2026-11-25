import type { WorkstreamDto } from '@10db/contracts';
import { Box, Button, Group, HoverCard, Stack, Text } from '@mantine/core';
import { useCloseTask, useRetryWorkstream } from '../../daemon/queries';
import { failureLine } from '../board/task-state';
import { StatusDot } from './status-dot';

/**
 * A failed line's red dot, which opens a card on hover: what happened and what Retry does, the agent's own
 * reason, then Open, Retry (where the daemon takes it) and Close. The card lives in a portal, so its clicks
 * stop here and never reach the line's own button.
 */
export function FailureDot({
  run,
  canRetry,
  canClose,
  onOpen,
}: {
  readonly run: WorkstreamDto;
  readonly canRetry: boolean;
  readonly canClose: boolean;
  readonly onOpen: () => void;
}) {
  const retry = useRetryWorkstream();
  const close = useCloseTask();
  const refusal = retry.error ?? close.error;
  return (
    <HoverCard width={380} position="bottom-start" withArrow shadow="md" openDelay={80}>
      <HoverCard.Target>
        <Box component="span" display="inline-flex" p={4} style={{ cursor: 'default' }}>
          <StatusDot color="red" />
        </Box>
      </HoverCard.Target>
      <HoverCard.Dropdown
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <Stack gap={8}>
          <Text size="sm">{failureLine(run, canRetry)}</Text>
          {run.failureReason === null ? null : (
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
              {run.failureReason}
            </Text>
          )}
          {refusal === null ? null : (
            <Text size="xs" c="red">
              {refusal.message}
            </Text>
          )}
          <Group gap={6} justify="flex-end">
            <Button size="compact-xs" variant="default" onClick={onOpen}>
              Open
            </Button>
            {canRetry ? (
              <Button
                size="compact-xs"
                variant="default"
                loading={retry.isPending}
                onClick={() => {
                  close.reset();
                  retry.mutate({ id: run.id });
                }}
              >
                Retry
              </Button>
            ) : null}
            {canClose ? (
              <Button
                size="compact-xs"
                variant="default"
                loading={close.isPending}
                onClick={() => {
                  retry.reset();
                  close.mutate(run.taskId);
                }}
              >
                Close
              </Button>
            ) : null}
          </Group>
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
