import {
  StepRole,
  type CellSetting,
  type PlaybookCellDto,
  type PlaybookSource,
} from '@10db/contracts';
import { ROLES } from './role-labels';

/** The scope's own name in a playbook's `source`: the global one, or a project's. */
export const scopeSource = (projectId: string | null): PlaybookSource =>
  projectId === null ? 'global' : 'project';

/**
 * What a scope itself sets in a cell: each field the scope set, and null (inherit) for one that comes from the
 * scope above or from 10db's default. A form sends this back with its one change, so editing a field never
 * copies an inherited value into the scope.
 */
export function ownCell(cell: PlaybookCellDto, source: PlaybookSource): CellSetting {
  return {
    personaId: cell.personaId.source === source ? cell.personaId.value : null,
    model: cell.model.source === source ? cell.model.value : null,
    effort: cell.effort.source === source ? cell.effort.value : null,
  };
}

/** Whether the cell sets nothing of its own. */
export const isEmptyCell = (cell: CellSetting): boolean =>
  cell.personaId === null && cell.model === null && cell.effort === null;

/**
 * The steps of a row after one role is switched on or off, in the order tasks meet them. Build always runs, and a
 * plan review needs a plan to judge: switching the plan off takes the review with it, and switching the review on
 * brings the plan.
 */
export function toggleStep(steps: readonly StepRole[], role: StepRole, on: boolean): StepRole[] {
  const next = new Set<StepRole>(steps);
  next.add(StepRole.Implement);
  if (role !== StepRole.Implement) {
    if (on) {
      next.add(role);
      if (role === StepRole.PlanReview) next.add(StepRole.Plan);
    } else {
      next.delete(role);
      if (role === StepRole.Plan) next.delete(StepRole.PlanReview);
    }
  }
  return ROLES.map((r) => r.role).filter((r) => next.has(r));
}
