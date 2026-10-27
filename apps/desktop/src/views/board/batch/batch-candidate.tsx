import { RiskTag, type FlowId, type PickerCandidate } from '@10db/contracts';
import {
  Alert,
  Badge,
  Checkbox,
  Code,
  Group,
  MultiSelect,
  Paper,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { useFlows, usePatchTask } from '../../../daemon/queries';
import { BatchSteps } from './batch-steps';

const RISK_TAGS: readonly RiskTag[] = Object.values(RiskTag);
const isRiskTag = (value: string): value is RiskTag => RISK_TAGS.some((t) => t === value);

export interface BatchCandidateProps {
  readonly candidate: PickerCandidate;
  readonly ticked: boolean;
  readonly onToggle: () => void;
}

/** One Ready task on the sheet: its tick, why the picker placed it, its flow and risk tags, its steps. */
export function BatchCandidate({ candidate, ticked, onToggle }: BatchCandidateProps) {
  const { task } = candidate;
  const flows = useFlows();
  const patch = usePatchTask();
  // The Select offers only IDs the daemon sent, so the lookup returns the branded ID without a cast.
  const flowById = new Map<string, FlowId>((flows.data ?? []).map((f) => [f.id, f.id]));
  return (
    <Paper withBorder radius="md" p="sm">
      <Stack gap="xs">
        <Group justify="space-between">
          <Checkbox label={task.title} checked={ticked} onChange={onToggle} />
          <Group gap={4}>
            {candidate.resumed ? (
              <Badge size="sm" variant="light">
                Resumed
              </Badge>
            ) : null}
            {candidate.unblocks > 0 ? (
              <Badge size="sm" variant="light" color="gray">
                {`Unblocks ${String(candidate.unblocks)}`}
              </Badge>
            ) : null}
          </Group>
        </Group>
        {candidate.conflict ? (
          <Text size="sm" c="yellow">
            {candidate.conflict}
          </Text>
        ) : null}
        <Group gap={4}>
          <Text size="xs" c="dimmed">
            Claims
          </Text>
          {candidate.claims.map((c) => (
            <Code key={`${c.kind}:${c.name}`}>
              {c.kind === 'hazard' ? `${c.name} (hazard)` : c.name}
            </Code>
          ))}
        </Group>
        <Group grow>
          <Select
            aria-label={`Flow for ${task.title}`}
            size="sm"
            placeholder="Project default flow"
            clearable
            data={(flows.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
            value={task.flowId}
            onChange={(v) => {
              patch.mutate({
                taskId: task.id,
                patch: { flowId: v === null ? null : (flowById.get(v) ?? null) },
              });
            }}
          />
          <MultiSelect
            aria-label={`Risk tags for ${task.title}`}
            size="sm"
            placeholder="Risk tags"
            data={[...RISK_TAGS]}
            value={[...task.riskTags]}
            onChange={(values) => {
              patch.mutate({ taskId: task.id, patch: { riskTags: values.filter(isRiskTag) } });
            }}
          />
        </Group>
        {patch.error ? (
          <Alert color="red" title="Couldn't change the task">
            {patch.error.message}
          </Alert>
        ) : null}
        {candidate.planError ? (
          <Alert color="red" title="No step plan">
            {candidate.planError}
          </Alert>
        ) : null}
        {candidate.plan ? <BatchSteps title={task.title} plan={candidate.plan} /> : null}
      </Stack>
    </Paper>
  );
}
