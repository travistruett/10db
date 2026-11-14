import {
  FixBy,
  REVIEW_ROLES,
  StepRole,
  type CellSetting,
  type PersonaDto,
  type PlaybookCellDto,
  type PlaybookRowDto,
  type PlaybookSource,
} from '@10db/contracts';
import { EFFORT_LABELS } from './rigor-labels';
import { ROLES } from './role-labels';
import { settingSummary } from './model-setting-options';

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

/** What a field's none choice says: where an unset field comes from, and what it comes to. */
export interface NoneLabels {
  readonly persona: string;
  readonly model: string;
  readonly effort: string;
  /** The minimum Intelligence an unset Automatic would inherit, for the minimum box's placeholder. */
  readonly minimumPlaceholder: string;
}

/**
 * The none choices of a cell's fields. Globally an unset field is 10db's default; in a project it is the global
 * playbook's, which already holds the default beneath it. A global field that is set hides the default under it,
 * so it reads only "Default".
 */
export function noneLabels(input: {
  readonly projectId: string | null;
  /** The cell as this scope sees it. */
  readonly cell: PlaybookCellDto;
  /** The same cell in the global playbook; used in a project. */
  readonly globalCell: PlaybookCellDto | null;
  readonly personas: readonly PersonaDto[];
  readonly names: ReadonlyMap<string, string>;
}): NoneLabels {
  const project = input.projectId !== null;
  const prefix = project ? 'Global' : 'Default';
  const above = project ? input.globalCell : input.cell;
  const own = ownCell(input.cell, scopeSource(input.projectId));
  // Globally, an own field replaced the default, so the default is no longer known.
  const known = (field: keyof CellSetting): boolean =>
    above !== null && (project || own[field] === null);
  const label = (field: keyof CellSetting, value: string): string =>
    known(field) ? `${prefix}: ${value}` : prefix;
  const model = above?.model.value ?? null;
  const personaId = above?.personaId.value ?? null;
  const effort = above?.effort.value ?? null;
  return {
    persona: label(
      'personaId',
      personaId === null
        ? 'the role’s own'
        : (input.personas.find((p) => p.id === personaId)?.name ?? 'a persona'),
    ),
    model: label('model', model === null ? 'Automatic' : inheritedModel(model, input.names)),
    effort: label('effort', effort === null ? 'Automatic' : EFFORT_LABELS[effort]),
    minimumPlaceholder:
      known('model') && model?.kind === 'automatic' && model.minimum !== undefined
        ? `${prefix} ${String(model.minimum)}`
        : 'No minimum',
  };
}

function inheritedModel(
  model: NonNullable<CellSetting['model']>,
  names: ReadonlyMap<string, string>,
): string {
  return model.kind === 'automatic'
    ? `Automatic${model.minimum === undefined ? '' : `, at least ${String(model.minimum)}`}`
    : settingSummary(model, names);
}

/** Whether a row's steps include one that judges work: a plan review, a review or QA. */
export const hasReviewingStep = (steps: readonly StepRole[]): boolean =>
  steps.some((s) => REVIEW_ROLES.includes(s));

/**
 * A row's process in a line: its review rounds and how a send-back is fixed, or "no review" when no step
 * reviews, and "you approve the plan" when the row asks for it and has a plan to approve.
 */
export function processLine(row: PlaybookRowDto): string {
  const rounds = row.reviewRounds.value;
  const review = hasReviewingStep(row.steps.value)
    ? [`${String(rounds)} ${rounds === 1 ? 'round' : 'rounds'}`, `${row.fixBy.value} fix`]
    : ['no review'];
  const approval =
    row.approvesPlan.value && row.steps.value.includes(StepRole.Plan)
      ? ['you approve the plan']
      : [];
  return [...review, ...approval].join(' · ');
}

/** What each way of fixing a send-back is called. */
export const FIX_BY_LABELS: Readonly<Record<FixBy, string>> = {
  [FixBy.Resumed]: 'The build session, resumed',
  [FixBy.Fresh]: 'A fresh build session',
};
