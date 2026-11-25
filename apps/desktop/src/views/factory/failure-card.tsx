import type { WorkstreamDto } from '@10db/contracts';
import { Box, Group, HoverCard, Stack, Text } from '@mantine/core';
import { useCloseTask, useRetryWorkstream } from '../../daemon/queries';
import { failureLine } from '../board/task-state';
import { FailureActions } from './failure-actions';
import { StatusDot } from './status-dot';

/**
 * A failed line's red dot, which opens a card on hover: what happened and what Retry does, the agent's own
 * reason, then Retry with Close Task in its menu (`FailureActions`); the line itself opens the task. The card
 * lives in a portal, so its clicks stop here and never reach the line's own button.
 */
export function FailureDot({
  run,
  canRetry,
  canClose,
}: {
  readonly run: WorkstreamDto;
  readonly canRetry: boolean;
  readonly canClose: boolean;
}) {
  const retry = useRetryWorkstream();
  const close = useCloseTask();
  const refusal = retry.error ?? close.error;
  return (
    <HoverCard width={380} position="bottom-start" withArrow openDelay={80}>
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
          <Group justify="flex-end">
            <FailureActions
              canRetry={canRetry}
              canClose={canClose}
              retrying={retry.isPending}
              closing={close.isPending}
              onRetry={() => {
                close.reset();
                retry.mutate({ id: run.id });
              }}
              onClose={() => {
                retry.reset();
                close.mutate(run.taskId);
              }}
            />
          </Group>
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
