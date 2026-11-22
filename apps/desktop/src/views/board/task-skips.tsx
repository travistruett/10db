import { SkipKind, type SkippedActionDto, type WorkstreamId } from '@10db/contracts';
import { Group, Stack, Text } from '@mantine/core';
import { useWorkstreamSkips } from '../../daemon/skip-queries';
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

export function TaskSkips({ workstreamId }: { readonly workstreamId: WorkstreamId | undefined }) {
  const now = useNow();
  const rows = useWorkstreamSkips(workstreamId).data ?? [];
  if (rows.length === 0) return null;
  const skipped = rows.filter((r) => r.kind !== SkipKind.Question);
  const asked = rows.filter((r) => r.kind === SkipKind.Question);
  return (
    <Stack gap={4}>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
        Skipped While Nobody Was Watching
      </Text>
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
