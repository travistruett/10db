import {
  Approval,
  SkipKind,
  WorkstreamState,
  type SkippedActionDto,
  type WorkstreamDto,
} from '@10db/contracts';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useRunSkippedCalls, useWorkstreamSkips } from '../../daemon/skip-queries';
import { absoluteTime, fromNow, useNow } from '../../shell/relative';

// Trust line §5: in a task's drawer, what its run skipped while nobody watched and the questions it
// was answered at once, each with why and when. A run that skipped nothing shows nothing.

function SkipRow({ skip, now }: { readonly skip: SkippedActionDto; readonly now: number }) {
  return (
    <Stack gap={0} role="listitem">
      <Text size="sm" ff="monospace" style={{ overflowWrap: 'anywhere' }}>
        {skip.summary}
      </Text>
      <Group gap={6} wrap="nowrap">
        <Text size="xs" c="dimmed">
          {skip.reason}
        </Text>
        <Text
          size="xs"
          c="dimmed"
          component="time"
          dateTime={skip.createdAt}
          title={absoluteTime(skip.createdAt)}
        >
          {fromNow(skip.createdAt, now)}
        </Text>
      </Group>
    </Stack>
  );
}

/**
 * What the run skipped and the questions it was answered at once. Once the run has ended, Run These Now
 * starts a follow-up that runs, approved, the calls a follow-up can run.
 */
export function TaskSkips({
  workstream,
  earlier = false,
}: {
  readonly workstream: WorkstreamDto | undefined;
  /** An earlier run of the task than the one the drawer shows: its heading says so. */
  readonly earlier?: boolean;
}) {
  const now = useNow();
  const rows = useWorkstreamSkips(workstream?.id).data ?? [];
  const run = useRunSkippedCalls();
  if (workstream === undefined || rows.length === 0) return null;
  const skipped = rows.filter((r) => r.kind !== SkipKind.Question);
  const asked = rows.filter((r) => r.kind === SkipKind.Question);
  const ended =
    workstream.state === WorkstreamState.Done || workstream.state === WorkstreamState.Failed;
  const runnable = ended && skipped.some((r) => r.approval !== Approval.None);
  return (
    <Stack gap={4}>
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
          {earlier
            ? `Skipped by an earlier run, ${absoluteTime(workstream.createdAt)}`
            : 'Skipped While Nobody Was Watching'}
        </Text>
        {runnable ? (
          <Button
            size="compact-xs"
            variant="default"
            loading={run.isPending}
            disabled={run.isSuccess}
            onClick={() => {
              run.mutate(workstream.id);
            }}
          >
            {run.isSuccess ? 'Follow-up Started' : 'Run These Now'}
          </Button>
        ) : null}
      </Group>
      {run.error === null ? null : (
        <Alert color="red" title="Couldn't run these">
          {run.error.message}
        </Alert>
      )}
      {skipped.length > 0 ? (
        <Stack gap={6} role="list" aria-label="Skipped calls">
          {skipped.map((skip) => (
            <SkipRow key={skip.id} skip={skip} now={now} />
          ))}
        </Stack>
      ) : null}
      {asked.length > 0 ? (
        <>
          <Text size="xs" fw={600} c="dimmed">
            Questions It Would Have Asked
          </Text>
          <Stack gap={6} role="list" aria-label="Questions It Would Have Asked">
            {asked.map((skip) => (
              <SkipRow key={skip.id} skip={skip} now={now} />
            ))}
          </Stack>
        </>
      ) : null}
    </Stack>
  );
}
