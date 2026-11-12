import type { AreaDef, GoalId, GoalPassPagesDto, TaskDto } from '@10db/contracts';
import { Button } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { goalReadyForPass } from './start-pass-rules';

export interface WorkOnThisProps {
  readonly goalId: GoalId;
  /** The page areas the goal's tasks committed in; undefined until read. */
  readonly passPages: GoalPassPagesDto | undefined;
  /** The goal's tasks. */
  readonly tasks: readonly TaskDto[];
  readonly areas: readonly AreaDef[];
}

/**
 * Factory's way into the Workbench for a goal (spec §4.2): shown once its tasks committed in a page
 * and its UI work is done or nearly so. The Workbench ticks those pages and links them to the goal.
 */
export function WorkOnThis({ goalId, passPages, tasks, areas }: WorkOnThisProps) {
  if (!passPages || passPages.pages.length === 0 || !goalReadyForPass(tasks, areas)) return null;
  return (
    <Button
      variant="default"
      size="xs"
      renderRoot={(props) => <Link {...props} to="/workbench" search={{ goal: goalId }} />}
    >
      Work on This
    </Button>
  );
}
