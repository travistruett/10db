import { latestPerTask, WorkstreamState, type BatchDto, type WorkstreamDto } from '@10db/contracts';
import { Button, Code, Group, Paper, Text, Tooltip } from '@mantine/core';
import { useAbandonBatch } from '../../daemon/queries';
import { abandonNote } from './batch/abandon-note';

/** The tasks in a batch: each one's latest run, without the cancelled. */
export function batchTaskCount(batch: BatchDto, workstreams: readonly WorkstreamDto[]): number {
  return latestPerTask(workstreams.filter((w) => w.batchId === batch.id)).filter(
    (w) => w.state !== WorkstreamState.Cancelled,
  ).length;
}

/** A batch earns a line above the columns only when several tasks share its branch. */
export function sharedBatches(
  batches: readonly BatchDto[],
  workstreams: readonly WorkstreamDto[],
): BatchDto[] {
  return batches.filter((batch) => batchTaskCount(batch, workstreams) > 1);
}

/** One slim line for a branch several tasks share: the branch, how many tasks, and Abandon. */
export function BatchStrip({
  batch,
  workstreams,
}: {
  readonly batch: BatchDto;
  readonly workstreams: readonly WorkstreamDto[];
}) {
  const abandon = useAbandonBatch();
  const note = abandonNote(batch, workstreams);
  return (
    <Paper withBorder px="sm" py={4}>
      <Group gap="sm" wrap="nowrap">
        {batch.branch ? <Code>{batch.branch}</Code> : null}
        <Text size="sm">{`${String(batchTaskCount(batch, workstreams))} tasks`}</Text>
        {note.refusal ? (
          <Text size="xs" c="dimmed">
            {note.refusal}
          </Text>
        ) : null}
        <Tooltip label={note.line} withArrow multiline maw={320}>
          <Button
            ml="auto"
            size="compact-sm"
            variant="default"
            loading={abandon.isPending}
            disabled={note.refusal !== null}
            onClick={() => {
              abandon.mutate(batch.id);
            }}
          >
            Abandon
          </Button>
        </Tooltip>
      </Group>
      {abandon.error ? (
        <Text size="xs" c="red" role="alert">
          {abandon.error.message}
        </Text>
      ) : null}
    </Paper>
  );
}
