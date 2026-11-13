import type { PickerCandidate } from '@10db/contracts';
import { Alert, Badge, Checkbox, Code, Group, Paper, Stack, Text } from '@mantine/core';
import { usePatchTask } from '../../../daemon/queries';
import { PlacementChoice } from '../placement-choice';
import { KindsSelect, RigorSelect } from '../task-fields';
import { BatchSteps } from './batch-steps';

export interface BatchCandidateProps {
  readonly candidate: PickerCandidate;
  /** Whether the project delivers by pull request, the only delivery with a separate copy to choose. */
  readonly placementEditable: boolean;
  readonly ticked: boolean;
  readonly onToggle: () => void;
}

/** One Ready task on the sheet: its tick, why the picker placed it, where it runs, its rigor and kinds, its steps. */
export function BatchCandidate({
  candidate,
  placementEditable,
  ticked,
  onToggle,
}: BatchCandidateProps) {
  const { task } = candidate;
  const patch = usePatchTask();
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
        {placementEditable ? (
          <PlacementChoice
            task={task}
            pending={patch.isPending}
            onChange={(workspaceMode) => {
              patch.mutate({ taskId: task.id, patch: { workspaceMode } });
            }}
          />
        ) : null}
        <Group grow>
          <RigorSelect
            aria-label={`Rigor for ${task.title}`}
            size="sm"
            value={task.rigor}
            projectId={task.projectId}
            kindKeys={task.kinds.map((k) => k.key)}
            onChange={(rigor) => {
              patch.mutate({ taskId: task.id, patch: { rigor } });
            }}
          />
          <KindsSelect
            aria-label={`Kinds for ${task.title}`}
            size="sm"
            value={task.kinds}
            onChange={(kinds) => {
              patch.mutate({ taskId: task.id, patch: { kinds } });
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
