import { reportOf, type WorkstreamStep } from '@10db/contracts';
import { Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { RelativeTime } from '../factory/relative-time';
import { CollapsedMarkdown } from './collapsed-markdown';

/**
 * What the build session said last, in full as it wrote it: what it did, found and could not do. The
 * label names the phase, so a reviewer's result in Reviews is never read as the build's. It is the
 * only result a task that changed nothing has. Its text is agent output, drawn by the conversation's safe markdown. Nothing
 * when the run has no report.
 */
export function TaskReport({
  steps,
  label,
}: {
  readonly steps: readonly WorkstreamStep[];
  readonly label: ReactNode;
}) {
  const report = reportOf(steps);
  if (report === null) return null;
  return (
    <Stack gap="xs" data-testid="task-report">
      <Group gap="xs">
        {label}
        <Text size="sm" c="dimmed">
          {`by ${report.personaName}`}
        </Text>
        <RelativeTime at={report.at} />
      </Group>
      <CollapsedMarkdown text={report.summary} />
    </Stack>
  );
}
