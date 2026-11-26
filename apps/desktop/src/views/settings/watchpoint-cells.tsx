import type { Watchpoint } from '@10db/contracts';
import { Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { PathSummary } from './table-cells';

/** A row's name with its marks beside it and why it matters under it, dimmed when it is off. */
export function WatchpointName({
  watchpoint,
  marks,
  off = false,
  whyLines = 2,
}: {
  readonly watchpoint: Watchpoint;
  readonly marks?: ReactNode;
  readonly off?: boolean;
  readonly whyLines?: number;
}) {
  return (
    <Stack gap={2}>
      <Group gap={6} wrap="nowrap">
        <Text size="sm" fw={600} {...(off ? { c: 'dimmed' } : {})}>
          {watchpoint.label}
        </Text>
        {marks}
      </Group>
      {watchpoint.why === '' ? null : (
        <Text size="xs" c="dimmed" lineClamp={whyLines} title={watchpoint.why}>
          {watchpoint.why}
        </Text>
      )}
    </Stack>
  );
}

/** The paths a watchpoint covers in brief, then how many line patterns narrow them. */
export function WatchpointMatches({ watchpoint }: { readonly watchpoint: Watchpoint }) {
  const patterns = watchpoint.lines.length;
  return (
    <Stack gap={4}>
      <PathSummary paths={watchpoint.globs} />
      {patterns > 0 ? (
        <Text size="xs" c="dimmed">
          {`+ ${String(patterns)} line pattern${patterns === 1 ? '' : 's'}`}
        </Text>
      ) : null}
    </Stack>
  );
}
