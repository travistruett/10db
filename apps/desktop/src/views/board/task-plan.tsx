import { planOf, type WorkstreamStep } from '@10db/contracts';
import { Code, Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { RelativeTime } from '../factory/relative-time';

/**
 * The latest plan the run recorded, from a Plan step or a build step that planned first, in full as its
 * author wrote it. Its text is agent output: shown as text only. Nothing when the run has no plan.
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
    <Stack gap={4} data-testid="task-plan">
      <Group gap="xs">
        {label}
        <Text size="sm" c="dimmed">
          {`by ${plan.personaName}`}
        </Text>
        <RelativeTime at={plan.at} />
      </Group>
      <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', width: '100%' }}>
        {plan.summary}
      </Code>
    </Stack>
  );
}
