import { GoalStatus, type GoalSummaryDto } from '@10db/contracts';
import { useState, type ReactNode } from 'react';
import { useShapeOf } from '../../daemon/shape-queries';
import { RemoveDraftGoalModal, type RemoveDraftGoalTarget } from './undo-modals';

// Shape spec §11: Remove Draft Goal is in a goal's menu and drawer, not only on its Shape row. It is
// for a goal a conversation made while none of its tasks has started; the daemon refuses anything
// else, so this only keeps the action from being offered to be refused. The digest's status says
// how far a goal got: its `state` stays Draft for life, since only the insert writes it.

/**
 * `available`: offer it. `started`: a conversation made the goal, but a task has started, so say
 * why. `none`: say nothing, because no conversation made it or its work is finished, and a builder
 * looking at a finished goal is not after this.
 */
export type RemoveDraftGoalOffer = 'available' | 'started' | 'none';

export function removeDraftGoalOffer(
  summary: GoalSummaryDto,
  madeByShape: boolean,
): RemoveDraftGoalOffer {
  if (!madeByShape) return 'none';
  const { status } = summary.digest;
  if (status === GoalStatus.NotStarted) return 'available';
  return status === GoalStatus.Done || status === GoalStatus.Shipping ? 'none' : 'started';
}

export interface RemoveDraftGoalAction {
  readonly offer: RemoveDraftGoalOffer;
  /** Opens the confirm. */
  readonly open: () => void;
  /** The confirm modal; render it once, beside the control that opens it. */
  readonly modal: ReactNode;
}

/** What the goal offers for Remove Draft Goal, and the confirm shared with the Shape row. */
export function useRemoveDraftGoalAction(summary: GoalSummaryDto): RemoveDraftGoalAction {
  const of = useShapeOf({ goalId: summary.goal.id });
  const [target, setTarget] = useState<RemoveDraftGoalTarget | null>(null);
  const offer = removeDraftGoalOffer(summary, of.data?.shapeId != null);
  return {
    offer,
    open: () => {
      setTarget({
        goalId: summary.goal.id,
        title: summary.goal.title,
        taskCount: summary.digest.progress.total,
      });
    },
    modal: (
      <RemoveDraftGoalModal
        target={target}
        onClose={() => {
          setTarget(null);
        }}
      />
    ),
  };
}
