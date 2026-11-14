import {
  FixBy,
  ModelTier,
  Rigor,
  Ships,
  StepRole,
  type CellSetting,
  type Effort,
} from '@10db/contracts';
import { effortAbove } from './pools';
import { ROLE_DEFAULT } from './role-defaults';

/** The steps each rigor runs, until a scope overrides them. */
export const DEFAULT_ROWS: Readonly<Record<Rigor, readonly StepRole[]>> = {
  [Rigor.Light]: [StepRole.Implement],
  [Rigor.Standard]: [StepRole.Implement, StepRole.Review],
  [Rigor.Careful]: [StepRole.Plan, StepRole.Implement, StepRole.Review],
  [Rigor.Critical]: [
    StepRole.Plan,
    StepRole.PlanReview,
    StepRole.Implement,
    StepRole.Review,
    StepRole.Qa,
  ],
};

/** How a rigor's reviewing steps and send-backs run, until a scope overrides it. */
export interface RowProcess {
  readonly reviewRounds: number;
  readonly fixBy: FixBy;
  readonly approvesPlan: boolean;
  /** Whether tasks of one goal at this rigor ship as one pull request. */
  readonly ships: Ships;
}

/** The process each rigor starts with. */
export const DEFAULT_PROCESS: Readonly<Record<Rigor, RowProcess>> = {
  [Rigor.Light]: {
    reviewRounds: 1,
    fixBy: FixBy.Resumed,
    approvesPlan: false,
    ships: Ships.WithGoal,
  },
  [Rigor.Standard]: {
    reviewRounds: 1,
    fixBy: FixBy.Resumed,
    approvesPlan: false,
    ships: Ships.WithGoal,
  },
  [Rigor.Careful]: { reviewRounds: 2, fixBy: FixBy.Fresh, approvesPlan: false, ships: Ships.Alone },
  [Rigor.Critical]: { reviewRounds: 2, fixBy: FixBy.Fresh, approvesPlan: true, ships: Ships.Alone },
};

/**
 * The role's own persona, any effort, and the cheapest model that scores at least `minimum` on the
 * Intelligence Index. The minimums below are 10db's own thresholds, not data from the index.
 */
const atLeast = (minimum: number): CellSetting => ({
  personaId: null,
  model: { kind: 'automatic', minimum },
  effort: null,
});

type RoleCells = Readonly<Partial<Record<StepRole, CellSetting>>>;

/** The cells each rigor starts with: one for each role its row runs. */
export const DEFAULT_CELLS: Readonly<Record<Rigor, RoleCells>> = {
  [Rigor.Light]: { [StepRole.Implement]: atLeast(35) },
  [Rigor.Standard]: { [StepRole.Implement]: atLeast(40), [StepRole.Review]: atLeast(40) },
  [Rigor.Careful]: {
    [StepRole.Plan]: atLeast(45),
    [StepRole.Implement]: atLeast(45),
    [StepRole.Review]: atLeast(48),
  },
  [Rigor.Critical]: {
    [StepRole.Plan]: atLeast(50),
    [StepRole.PlanReview]: atLeast(52),
    [StepRole.Implement]: atLeast(50),
    [StepRole.Review]: atLeast(52),
    [StepRole.Qa]: atLeast(35),
  },
};

/** The rung a cell runs on when no profile on the account has a score: a tier, whether to take its top, and an effort. */
export interface FallbackRung {
  readonly tier: ModelTier;
  readonly top: boolean;
  readonly effort: Effort;
}

type RoleRungs = Readonly<Partial<Record<StepRole, FallbackRung>>>;

/**
 * Light and Standard run the role's default tier and effort; Careful the same one effort up; Critical
 * the top of Capable and Frontier together, one effort up.
 */
function fallbackFor(rigor: Rigor, role: StepRole): FallbackRung {
  const base = ROLE_DEFAULT[role];
  switch (rigor) {
    case Rigor.Light:
    case Rigor.Standard:
      return { tier: base.tier, top: false, effort: base.effort };
    case Rigor.Careful:
      return { tier: base.tier, top: false, effort: effortAbove(base.effort) };
    case Rigor.Critical:
      return { tier: ModelTier.Capable, top: true, effort: effortAbove(base.effort) };
  }
}

function rungsOf(rigor: Rigor): RoleRungs {
  const rungs: Partial<Record<StepRole, FallbackRung>> = {};
  for (const role of Object.values(StepRole))
    if (DEFAULT_CELLS[rigor][role] !== undefined) rungs[role] = fallbackFor(rigor, role);
  return rungs;
}

/** The fallback rung of each cell in `DEFAULT_CELLS`. */
export const FALLBACK_RUNG: Readonly<Record<Rigor, RoleRungs>> = {
  [Rigor.Light]: rungsOf(Rigor.Light),
  [Rigor.Standard]: rungsOf(Rigor.Standard),
  [Rigor.Careful]: rungsOf(Rigor.Careful),
  [Rigor.Critical]: rungsOf(Rigor.Critical),
};
