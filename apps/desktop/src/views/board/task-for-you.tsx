import type { WorkstreamId } from '@10db/contracts';
import { Group, Stack, Text } from '@mantine/core';
import { useWatchpointHits } from '../../daemon/watchpoint-queries';
import { count, WatchpointFolds, WholeDiff } from './watchpoint-folds';

// A task's For You: the changes that touch what the builder watches, one fold per watchpoint. The hunks are kept
// with the run, so a task that is Done still shows them. A run that touched nothing the builder watches shows
// nothing.

export function TaskForYou({ workstreamId }: { readonly workstreamId: WorkstreamId | undefined }) {
  const reading = useWatchpointHits(workstreamId).data;
  if (workstreamId === undefined || reading === undefined) return null;
  if (reading.skipped !== null)
    return (
      <Stack gap={4}>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
          For You
        </Text>
        <Text size="sm" c="dimmed">
          Couldn&apos;t read this run&apos;s changes.
        </Text>
      </Stack>
    );
  if (reading.hits.length === 0) return null;
  const files = reading.hits.reduce((n, h) => n + h.files.length, 0);
  return (
    <Stack gap="xs" data-testid="for-you">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs">
          <Text size="xs" fw={600} c="dimmed" tt="uppercase">
            For You
          </Text>
          <Text size="xs" c="dimmed">
            {`${count(reading.hits.length, 'watchpoint', 'watchpoints')} · ${count(files, 'file', 'files')}`}
          </Text>
        </Group>
        {reading.canOpenDiff ? <WholeDiff workstreamId={workstreamId} /> : null}
      </Group>
      <WatchpointFolds hits={reading.hits} open="asked" />
    </Stack>
  );
}
