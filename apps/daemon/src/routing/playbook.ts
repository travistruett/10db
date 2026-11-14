import {
  ModelTier,
  RIGORS,
  StepRole,
  type CellSetting,
  type Effort,
  type KindDto,
  type ModelSetting,
  type PersonaId,
  type Rigor,
  type TaskKind,
} from '@10db/contracts';
import type { PlaybookOverrides } from '@10db/db';
import { DEFAULT_CELLS, DEFAULT_ROWS, FALLBACK_RUNG, type FallbackRung } from './playbook-defaults';
import { effortAbove, effortLevel } from './pools';
import { ROLE_DEFAULT } from './role-defaults';

/** The playbook overrides a task reads: its project's own, when it has any, and the global ones. */
export interface PlaybookScopes {
  readonly project: PlaybookOverrides | null;
  readonly global: PlaybookOverrides;
}

/** What one step of a task asks of the router. */
export interface ResolvedStep {
  readonly role: StepRole;
  /** The persona the playbook names, or null for the role's own. */
  readonly personaId: PersonaId | null;
  /** The cell's model setting and each kind override's; the router takes the strongest result. */
  readonly requirements: readonly ModelSetting[];
  /** The highest effort any of them fixes; null leaves it to the router. */
  readonly effort: Effort | null;
  /** The Intelligence Index score an `automatic` requirement routes at. */
  readonly need: number;
  /** The rung to run on when no profile has a score; null for a step no cell describes. */
  readonly fallback: FallbackRung | null;
  /** The cell names one model, so a retry never steps it up. */
  readonly pinned: boolean;
}

/**
 * The rung a step runs on when nothing is scored. A step that needs more than its default cell asks, a
 * builder's higher "at least" or a persona's minimum moved into the cell, takes the top of Capable and
 * Frontier one effort up, as a minimum above the step's need always did.
 */
function fallbackFor(
  rung: FallbackRung | null,
  role: StepRole,
  need: number,
  defaultMinimum: number | null,
): FallbackRung | null {
  if (rung === null || defaultMinimum === null || need <= defaultMinimum) return rung;
  const raised = effortAbove(ROLE_DEFAULT[role].effort);
  return {
    tier: ModelTier.Capable,
    top: true,
    effort: effortLevel(rung.effort) >= effortLevel(raised) ? rung.effort : raised,
  };
}

/**
 * The rung at the effort it runs on unscored: the cell's own, else the rung's, and never below a kind's, so a
 * kind that fixes an effort can only raise a step.
 */
function withEffort(
  rung: FallbackRung | null,
  cellEffort: Effort | null,
  kindEfforts: readonly (Effort | null)[],
): FallbackRung | null {
  if (rung === null) return null;
  return { ...rung, effort: strongest([cellEffort ?? rung.effort, ...kindEfforts]) ?? rung.effort };
}

const ROLES: readonly StepRole[] = Object.values(StepRole);

const scopesOf = (playbook: PlaybookScopes): PlaybookOverrides[] =>
  playbook.project === null ? [playbook.global] : [playbook.project, playbook.global];

/** The steps a rigor's row runs: the project's row, else the global one, else the default. */
function rowSteps(rigor: Rigor, playbook: PlaybookScopes): readonly StepRole[] {
  for (const scope of scopesOf(playbook)) {
    const row = scope.rows.find((r) => r.rigor === rigor);
    if (row) return row.steps;
  }
  return DEFAULT_ROWS[rigor];
}

/** Each field of the cell, from the project's cell, else the global one, else the default. */
function cellOf(rigor: Rigor, role: StepRole, playbook: PlaybookScopes): CellSetting {
  const found = scopesOf(playbook).flatMap((scope) =>
    scope.cells.filter((c) => c.rigor === rigor && c.role === role),
  );
  const fallback = DEFAULT_CELLS[rigor][role];
  return {
    personaId: found.find((c) => c.personaId !== null)?.personaId ?? fallback?.personaId ?? null,
    model: found.find((c) => c.model !== null)?.model ?? fallback?.model ?? null,
    effort: found.find((c) => c.effort !== null)?.effort ?? fallback?.effort ?? null,
  };
}

const minimumOf = (model: ModelSetting | null | undefined): number | null =>
  model?.kind === 'automatic' ? (model.minimum ?? null) : null;

function strongest(efforts: readonly (Effort | null)[]): Effort | null {
  let best: Effort | null = null;
  for (const effort of efforts)
    if (effort !== null && (best === null || effortLevel(effort) > effortLevel(best)))
      best = effort;
  return best;
}

/**
 * The steps a task runs and what each asks of the router. The steps are the rigor's row plus those its
 * kinds add, in role order. A step's cell is the rigor's; a step only a kind added takes the cell of
 * the lowest stronger rigor that runs the role. A kind's override can only add a requirement or raise
 * the effort, so a kind never makes a step weaker than its cell.
 */
export function resolveSteps(input: {
  readonly rigor: Rigor;
  readonly taskKinds: readonly TaskKind[];
  readonly kinds: readonly KindDto[];
  readonly playbook: PlaybookScopes;
}): ResolvedStep[] {
  const { rigor, playbook } = input;
  // Where kinds disagree, the builder's order of kinds decides, not the order the task names them in.
  const own = input.kinds
    .filter((k) => input.taskKinds.some((tk) => tk.key === k.key))
    .sort((a, b) => a.position - b.position);
  const wanted = new Set<StepRole>([
    ...rowSteps(rigor, playbook),
    ...own.flatMap((k) => k.addsSteps),
  ]);
  // A plan review judges a plan, so a row that gains one gains the plan too.
  if (wanted.has(StepRole.PlanReview)) wanted.add(StepRole.Plan);
  const roles = ROLES.filter((role) => wanted.has(role));
  return roles.map((role): ResolvedStep => {
    const stronger = RIGORS.slice(RIGORS.indexOf(rigor));
    // No overridden row runs a role a kind added: 10db's own rows say which cell it takes.
    const cellRigor =
      stronger.find((r) => rowSteps(r, playbook).includes(role)) ??
      stronger.find((r) => DEFAULT_ROWS[r].includes(role)) ??
      rigor;
    const cell = cellOf(cellRigor, role, playbook);
    const overrides = own.flatMap((k) => k.overrides[role] ?? []);
    const requirements = [cell.model, ...overrides.map((o) => o.model)].filter(
      (m): m is ModelSetting => m !== null,
    );
    const defaultMinimum = minimumOf(DEFAULT_CELLS[cellRigor][role]?.model);
    const ownMinimum = minimumOf(cell.model) ?? defaultMinimum ?? 0;
    const need = Math.max(ownMinimum, ...overrides.map((o) => minimumOf(o.model) ?? 0));
    return {
      role,
      personaId: overrides.find((o) => o.personaId !== null)?.personaId ?? cell.personaId,
      requirements: requirements.length > 0 ? requirements : [{ kind: 'automatic' }],
      effort: strongest([cell.effort, ...overrides.map((o) => o.effort)]),
      need,
      fallback: withEffort(
        fallbackFor(FALLBACK_RUNG[cellRigor][role] ?? null, role, need, defaultMinimum),
        cell.effort,
        overrides.map((o) => o.effort),
      ),
      pinned: cell.model?.kind === 'model',
    };
  });
}
