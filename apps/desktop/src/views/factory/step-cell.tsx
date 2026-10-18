import { Badge, Stack, Text } from '@mantine/core';
import type { WorkstreamDto } from '@10db/contracts';

/** The step a workstream is on, who runs it and on which profile; a pre-flow workstream shows its model. */
export function StepCell({ workstream }: { readonly workstream: WorkstreamDto }) {
  const step = workstream.steps[workstream.stepIndex];
  if (!step) return <Text size="sm">{`${workstream.model}@${workstream.effort}`}</Text>;
  return (
    <Stack gap={0}>
      <Text size="sm">{`${String(workstream.stepIndex + 1)}/${String(workstream.steps.length)} ${step.role}`}</Text>
      <Text size="xs" c="dimmed" title={step.reason}>
        {`${step.personaName} · ${step.model}@${step.effort}`}
      </Text>
      {step.attempts > 0 ? (
        <Badge size="xs" variant="light" color="orange">{`retry ${String(step.attempts)}`}</Badge>
      ) : null}
    </Stack>
  );
}
