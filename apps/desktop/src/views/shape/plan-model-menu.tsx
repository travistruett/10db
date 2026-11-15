import type { ShapeViewDto } from '@10db/contracts';
import { ModelMenu } from '../../conversation/model-menu';
import { useChooseShapeModel } from '../../daemon/shape-queries';

export interface PlanModelMenuProps {
  readonly view: ShapeViewDto;
}

/**
 * The Plan composer's model and effort chip: the choice applies from the conversation's next turn, so
 * the chip is off while one runs or waits, and the daemon's refusal shows beside it.
 */
export function PlanModelMenu({ view }: PlanModelMenuProps) {
  const choose = useChooseShapeModel();
  return (
    <ModelMenu
      offered={view.models.offered}
      default={view.models.default}
      picked={view.shape.model}
      effort={view.shape.effort}
      busy={view.turn.running || view.turn.queued > 0}
      pending={choose.isPending}
      error={choose.error?.message ?? null}
      onPick={(model, effort) => {
        choose.mutate({ shapeId: view.shape.id, model, effort });
      }}
    />
  );
}
