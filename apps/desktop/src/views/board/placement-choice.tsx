import { WorkspaceMode, type TaskDto } from '@10db/contracts';
import { Group, SegmentedControl, Text } from '@mantine/core';
import { placementLabel } from './placement';

export interface PlacementChoiceProps {
  readonly task: Pick<TaskDto, 'title' | 'workspaceMode' | 'placementReason'>;
  readonly pending: boolean;
  /** Says the reason beside the control; off where a badge already carries it as a tooltip. */
  readonly showReason?: boolean;
  readonly onChange: (mode: WorkspaceMode) => void;
}

/** Where the task will run: Your folder or a separate copy, with the reason it was proposed beside it. */
export function PlacementChoice({
  task,
  pending,
  showReason = true,
  onChange,
}: PlacementChoiceProps) {
  return (
    <Group gap="sm" wrap="nowrap">
      <SegmentedControl
        size="xs"
        aria-label={`Where ${task.title} runs`}
        value={task.workspaceMode}
        disabled={pending}
        data={Object.values(WorkspaceMode).map((mode) => ({
          value: mode,
          label: placementLabel(mode),
        }))}
        onChange={(value) => {
          const mode = Object.values(WorkspaceMode).find((m) => m === value);
          if (mode !== undefined && mode !== task.workspaceMode) onChange(mode);
        }}
      />
      {showReason && task.placementReason ? (
        <Text size="xs" c="dimmed">
          {task.placementReason}
        </Text>
      ) : null}
    </Group>
  );
}
