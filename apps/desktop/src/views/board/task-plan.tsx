import { planOf, type WorkstreamStep } from '@10db/contracts';
import { Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { RelativeTime } from '../factory/relative-time';
import { CollapsedMarkdown } from './collapsed-markdown';

/**
 * The latest plan the run recorded, from a Plan step or a build step that planned first, in full as its
 * author wrote it. Its text is agent output, drawn by the conversation's safe markdown. Nothing when the run has no plan.
 */
export function TaskPlan({
  steps,
  label,
}: {
  readonly steps: readonly WorkstreamStep[];
  readonly label: ReactNode;
}) {
  const plan = planOf(steps);
  if (plan === null) return null;
  return (
    <Stack gap="xs" data-testid="task-plan">
      <Group gap="xs">
        {label}
        <Text size="sm" c="dimmed">
          {`by ${plan.personaName}`}
        </Text>
        <RelativeTime at={plan.at} />
      </Group>
      <CollapsedMarkdown text={plan.summary} />
    </Stack>
  );
}
