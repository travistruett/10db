import type { TaskDto } from '@10db/contracts';
import { Badge, Tooltip } from '@mantine/core';
import { placementLabel } from './placement';

/** Where the task will run, with the reason it was proposed as the tooltip when there is one. */
export function PlacementBadge({
  task,
}: {
  readonly task: Pick<TaskDto, 'workspaceMode' | 'placementReason'>;
}) {
  const badge = (
    <Badge
      size="sm"
      variant="outline"
      color="gray"
      tt="none"
      fw={500}
      data-testid="placement-badge"
    >
      {placementLabel(task.workspaceMode)}
    </Badge>
  );
  return task.placementReason ? (
    <Tooltip label={task.placementReason} withArrow>
      {badge}
    </Tooltip>
  ) : (
    badge
  );
}
