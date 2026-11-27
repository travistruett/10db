import { WatchpointCoverageState, type Watchpoint, type WatchpointCoverage } from '@10db/contracts';
import { Group, Skeleton, Stack, Text } from '@mantine/core';
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

/** How many files a count covers: a skeleton while it is read, and "No files here", dimmed, when it is none. */
export function CoverageCount({ coverage }: { readonly coverage: WatchpointCoverage | undefined }) {
  if (coverage === undefined || coverage.state === WatchpointCoverageState.Counting)
    return <Skeleton h={12} w={64} aria-label="Counting the files" />;
  if (coverage.state === WatchpointCoverageState.Unreadable)
    return (
      <Text size="xs" c="dimmed">
        Not counted
      </Text>
    );
  if (coverage.files === 0 && !coverage.partial)
    return (
      <Text size="xs" c="dimmed">
        No files here
      </Text>
    );
  if (coverage.files === 0)
    return (
      <Text size="xs" c="dimmed">
        Not counted
      </Text>
    );
  const files = `${String(coverage.files)} file${coverage.files === 1 ? '' : 's'}`;
  if (coverage.asks) return <Text size="xs">{`Asks about ${files}`}</Text>;
  return <Text size="xs">{coverage.partial ? `At least ${files}` : files}</Text>;
}

/** The paths a watchpoint covers in brief, how many line patterns narrow them, and how many files that covers. */
export function WatchpointMatches({
  watchpoint,
  coverage,
  shown,
}: {
  readonly watchpoint: Watchpoint;
  /** The count read from the checkout; a skeleton shows until it is given. */
  readonly coverage?: WatchpointCoverage | undefined;
  /** How many paths show before "+N more"; PathSummary's own count when not given. */
  readonly shown?: number;
}) {
  const patterns = watchpoint.lines.length;
  return (
    <Stack gap={4}>
      <PathSummary paths={watchpoint.globs} {...(shown === undefined ? {} : { shown })} />
      {patterns > 0 ? (
        <Text size="xs" c="dimmed">
          {`+ ${String(patterns)} line pattern${patterns === 1 ? '' : 's'}`}
        </Text>
      ) : null}
      <CoverageCount coverage={coverage} />
    </Stack>
  );
}
