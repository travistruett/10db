import { StepRole, type FlowDto, type FlowId } from '@10db/contracts';
import { Select, Stack, Text, type SelectProps } from '@mantine/core';
import { useFlows } from '../../daemon/queries';

const ROLE_LABEL: Readonly<Record<StepRole, string>> = {
  [StepRole.Plan]: 'Plan',
  [StepRole.PlanReview]: 'Plan review',
  [StepRole.Implement]: 'Build',
  [StepRole.Review]: 'Review',
  [StepRole.Qa]: 'QA',
};

/** A flow's key ("quick", "plan-first") as a title: "Quick", "Plan First". */
export function flowTitle(name: string): string {
  return name
    .split('-')
    .map((word) => (word === '' ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`))
    .join(' ');
}

/** The steps a flow can run, in order; a step it may skip still counts, since the task decides. */
const stepsOf = (flow: FlowDto) => flow.steps.map((s) => ROLE_LABEL[s.role]).join(' → ');

export interface FlowSelectProps extends Omit<SelectProps, 'data' | 'value' | 'onChange'> {
  readonly value: FlowId | null;
  readonly onChange: (flowId: FlowId | null) => void;
}

/** Picks a flow by title, fewest steps first, with each option's steps as its byline. */
export function FlowSelect({ value, onChange, ...props }: FlowSelectProps) {
  const flows = [...(useFlows().data ?? [])].sort((a, b) => a.steps.length - b.steps.length);
  // The Select hands back an unbranded string; looking it up returns the branded ID without a cast.
  const byId = new Map<string, FlowDto>(flows.map((f) => [f.id, f]));
  return (
    <Select
      {...props}
      data={flows.map((f) => ({ value: f.id, label: flowTitle(f.name) }))}
      value={value}
      onChange={(v) => {
        onChange(v === null ? null : (byId.get(v)?.id ?? null));
      }}
      renderOption={({ option }) => {
        const flow = byId.get(option.value);
        return (
          <Stack gap={0}>
            <Text size="sm">{option.label}</Text>
            {flow ? (
              <Text size="xs" c="dimmed">
                {stepsOf(flow)}
              </Text>
            ) : null}
          </Stack>
        );
      }}
    />
  );
}
