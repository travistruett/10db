import { WorkstreamState, type WorkstreamDto } from '@10db/contracts';
import { Badge, Stack, Text } from '@mantine/core';

/**
 * The step a workstream is on, who runs it and on which profile; a pre-flow workstream shows its
 * model. A run that has not started names no step: its plan would read as work under way.
 */
export function StepCell({ workstream }: { readonly workstream: WorkstreamDto }) {
  if (workstream.state === WorkstreamState.Queued) {
    return (
      <Text size="sm" c="dimmed">
        Waiting for a free lane
      </Text>
    );
  }
  if (workstream.state === WorkstreamState.Held) {
    return (
      <Text size="sm" c="dimmed">
        Held: not in the queue
      </Text>
    );
  }
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
