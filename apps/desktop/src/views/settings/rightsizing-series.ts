import {
  ModelTier,
  type ModelProfileId,
  type ModelRowDto,
  type RolePickDto,
  type StepRole,
} from '@10db/contracts';
import { TIER_LABEL } from './model-labels';
import { paretoFrontier, type ParetoPoint } from './pareto';
import { ROLES } from './role-labels';

/** Which points the chart draws: every effort of every model, or only the frontier. */
export const DotsMode = { Every: 'every', Pareto: 'pareto' } as const;
export type DotsMode = (typeof DotsMode)[keyof typeof DotsMode];

/** A model at an effort that has an Intelligence and a cost to place it by. */
export interface ChartPoint extends ParetoPoint {
  /** The point's place in `points`, which the chart's data carries to find it again. */
  readonly id: number;
  readonly profileId: ModelProfileId;
  readonly name: string;
  readonly tier: ModelTier | null;
}

export interface TierSeries {
  readonly name: string;
  readonly color: string;
  readonly data: readonly {
    readonly cost: number;
    readonly intelligence: number;
    readonly id: number;
  }[];
}

/** A dashed line at a role's need; roles that need the same are one line. */
export interface NeedLine {
  readonly need: number;
  readonly label: string;
}

/** A ring on the point a pick stands on. */
export interface PickRing {
  readonly role: StepRole;
  readonly cost: number;
  readonly intelligence: number;
  /** Another role is selected, so this one fades. */
  readonly dimmed: boolean;
}

export interface RightsizingSeries {
  /** Every measured point, by id; the series hold the ones drawn. */
  readonly points: readonly ChartPoint[];
  readonly series: readonly TierSeries[];
  /** The frontier of the measured points, cheapest first, whichever are drawn. */
  readonly pareto: readonly ChartPoint[];
  readonly lines: readonly NeedLine[];
  readonly rings: readonly PickRing[];
  /** Roles whose pick has no drawn point: unmeasured, a cost of 0, hidden by a filter, or no profile. */
  readonly notOnChart: readonly StepRole[];
  /** From a need up, as far right as the dearest drawn pick; null where no pick is drawn. */
  readonly area: { readonly need: number; readonly top: number; readonly cost: number } | null;
  /** The log axis's ticks: a 1-2-5 ladder from the rung under the cheapest drawn point to the one over the dearest. */
  readonly ticks: readonly number[];
  /** Efforts with no Intelligence or no cost above 0, which have no place on the chart. */
  readonly omitted: number;
}

/** The top of the Intelligence scale, where the shaded area ends. */
const SCALE_TOP = 100;
const LADDER = [1, 2, 5] as const;

/** The 1-2-5 rungs around a span of costs, from the last at or under `min` to the first over it at or past `max`. */
export function costTicks(min: number, max: number): number[] {
  if (!(min > 0) || max < min) return [];
  const lowExp = Math.floor(Math.log10(min)) - 1;
  const highExp = Math.ceil(Math.log10(max)) + 1;
  const rungs: number[] = [];
  for (let exp = lowExp; exp <= highExp; exp += 1)
    for (const m of LADDER) rungs.push(Number((m * Math.pow(10, exp)).toPrecision(12)));
  const from = rungs.findLastIndex((r) => r <= min);
  const to = rungs.findIndex((r, i) => i > from && r >= max);
  return rungs.slice(from, to + 1);
}

/** A tick on the cost axis: whole dollars bare, cents to two places, and sub-cent rungs as they are. */
export function costTickLabel(value: number): string {
  if (value >= 1) return `$${String(value)}`;
  return value < 0.01 ? `$${String(value)}` : `$${value.toFixed(2)}`;
}

const SERIES_COLORS: Readonly<Record<ModelTier, string>> = {
  [ModelTier.Efficient]: 'teal',
  [ModelTier.Balanced]: 'blue',
  [ModelTier.Capable]: 'violet',
  [ModelTier.Frontier]: 'grape',
};
const NO_TIER = { name: 'No tier', color: 'gray' } as const;
const TIER_ORDER: readonly (ModelTier | null)[] = [
  ModelTier.Efficient,
  ModelTier.Balanced,
  ModelTier.Capable,
  ModelTier.Frontier,
  null,
];

const roleLabel = (role: StepRole): string => ROLES.find((r) => r.role === role)?.label ?? role;

function measuredPoints(rows: readonly ModelRowDto[]): { points: ChartPoint[]; omitted: number } {
  const points: ChartPoint[] = [];
  let omitted = 0;
  for (const row of rows) {
    for (const e of row.efforts) {
      if (e.intelligence === null || e.costPerTaskUsd === null || e.costPerTaskUsd <= 0) {
        omitted += 1;
        continue;
      }
      points.push({
        id: points.length,
        profileId: e.profileId,
        model: row.model,
        name: row.name,
        effort: e.effort,
        tier: row.tier,
        cost: e.costPerTaskUsd,
        intelligence: e.intelligence,
      });
    }
  }
  return { points, omitted };
}

function needLines(picks: readonly RolePickDto[], role: StepRole | null): NeedLine[] {
  const byNeed = new Map<number, StepRole[]>();
  for (const pick of picks) {
    if (role !== null && pick.role !== role) continue;
    byNeed.set(pick.need, [...(byNeed.get(pick.need) ?? []), pick.role]);
  }
  return [...byNeed].map(([need, roles]) => ({
    need,
    label: `${roles.map(roleLabel).join(', ')} ${String(need)}`,
  }));
}

/**
 * What the Models chart draws, from the rows (already limited to the chart's account and filters), the router's
 * picks for that account, the selected role and the dots mode. A ring is found by profile among the drawn points
 * only, so it never circles a point the chart does not show; in Pareto only the picks' own points stay drawn.
 */
export function rightsizingSeries(input: {
  readonly rows: readonly ModelRowDto[];
  readonly picks: readonly RolePickDto[];
  readonly role: StepRole | null;
  readonly dots: DotsMode;
}): RightsizingSeries {
  const { points, omitted } = measuredPoints(input.rows);
  const pareto = paretoFrontier(points);
  const pickedProfiles = new Set(input.picks.map((p) => p.profileId));
  const drawn =
    input.dots === DotsMode.Every
      ? points
      : points.filter((p) => pareto.includes(p) || pickedProfiles.has(p.profileId));

  const series = TIER_ORDER.flatMap((tier) => {
    const here = drawn.filter((p) => p.tier === tier);
    if (here.length === 0) return [];
    const look = tier === null ? NO_TIER : { name: TIER_LABEL[tier], color: SERIES_COLORS[tier] };
    return [
      {
        ...look,
        data: here.map((p) => ({ cost: p.cost, intelligence: p.intelligence, id: p.id })),
      },
    ];
  });

  const rings: PickRing[] = [];
  const notOnChart: StepRole[] = [];
  for (const pick of input.picks) {
    const point = drawn.find((p) => p.profileId === pick.profileId);
    if (point === undefined) {
      notOnChart.push(pick.role);
      continue;
    }
    rings.push({
      role: pick.role,
      cost: point.cost,
      intelligence: point.intelligence,
      dimmed: input.role !== null && pick.role !== input.role,
    });
  }

  const inScope = input.role === null ? rings : rings.filter((r) => r.role === input.role);
  const needs = input.picks.filter((p) => input.role === null || p.role === input.role);
  const lowest = needs.length === 0 ? null : Math.min(...needs.map((p) => p.need));
  const area =
    lowest === null || inScope.length === 0
      ? null
      : { need: lowest, top: SCALE_TOP, cost: Math.max(...inScope.map((r) => r.cost)) };

  return {
    points,
    series,
    pareto,
    lines: needLines(input.picks, input.role),
    rings,
    notOnChart,
    area,
    ticks: costTicks(Math.min(...drawn.map((p) => p.cost)), Math.max(...drawn.map((p) => p.cost))),
    omitted,
  };
}
