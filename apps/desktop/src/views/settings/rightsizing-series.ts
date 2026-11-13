import type { ModelProfileId, ModelRowDto, RolePickDto, StepRole } from '@10db/contracts';
import { paretoFrontier, type ParetoPoint } from './pareto';
import { ROLES } from './role-labels';

/** Which points the chart draws: every effort of every model, or only the frontier. */
export const DotsMode = { Every: 'every', Frontier: 'frontier' } as const;
export type DotsMode = (typeof DotsMode)[keyof typeof DotsMode];

/** A model at an effort that has an Intelligence and a cost to place it by. */
export interface ChartPoint extends ParetoPoint {
  /** The point's place in `points`, which the chart's data carries to find it again. */
  readonly id: number;
  readonly profileId: ModelProfileId;
  readonly name: string;
}

/** The points of one colour: gray for a point, blue for one on the frontier. */
export interface PointSeries {
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
}

export interface RightsizingSeries {
  /** Every measured point, by id; the series hold the ones drawn. */
  readonly points: readonly ChartPoint[];
  /** The drawn points that are not on the frontier, gray, then the ones that are, blue. */
  readonly series: readonly PointSeries[];
  /** The frontier of the measured points, cheapest first, whichever are drawn. */
  readonly frontier: readonly ChartPoint[];
  readonly lines: readonly NeedLine[];
  readonly rings: readonly PickRing[];
  /** Roles whose pick has no drawn point: unmeasured, a cost of 0, or no profile. */
  readonly notOnChart: readonly StepRole[];
  /** The log axis's ticks: a 1-2-5 ladder from the rung under the cheapest drawn point to the one over the dearest. */
  readonly ticks: readonly number[];
  /** Efforts with no Intelligence or no cost above 0, which have no place on the chart. */
  readonly omitted: number;
}

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

const OTHER_SERIES = { name: 'Other efforts', color: 'gray.6' } as const;
const FRONTIER_SERIES = { name: 'Frontier', color: 'blue.6' } as const;

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
 * What the Models chart draws, from the rows, the router's picks for the page's account, the selected role and the
 * dots mode. A ring is found by profile among the drawn points only, so it never circles a point the chart does
 * not show; on the frontier only, the picks' own points stay drawn. A selected role leaves only its need line and
 * its ring.
 */
export function rightsizingSeries(input: {
  readonly rows: readonly ModelRowDto[];
  readonly picks: readonly RolePickDto[];
  readonly role: StepRole | null;
  readonly dots: DotsMode;
}): RightsizingSeries {
  const { points, omitted } = measuredPoints(input.rows);
  const frontier = paretoFrontier(points);
  const pickedProfiles = new Set(input.picks.map((p) => p.profileId));
  const drawn =
    input.dots === DotsMode.Every
      ? points
      : points.filter((p) => frontier.includes(p) || pickedProfiles.has(p.profileId));

  const asData = (here: readonly ChartPoint[]) =>
    here.map((p) => ({ cost: p.cost, intelligence: p.intelligence, id: p.id }));
  const others = drawn.filter((p) => !frontier.includes(p));
  const onFrontier = drawn.filter((p) => frontier.includes(p));
  const series = [
    ...(others.length === 0 ? [] : [{ ...OTHER_SERIES, data: asData(others) }]),
    ...(onFrontier.length === 0 ? [] : [{ ...FRONTIER_SERIES, data: asData(onFrontier) }]),
  ];

  const rings: PickRing[] = [];
  const notOnChart: StepRole[] = [];
  for (const pick of input.picks) {
    const point = drawn.find((p) => p.profileId === pick.profileId);
    if (point === undefined) {
      notOnChart.push(pick.role);
      continue;
    }
    if (input.role === null || pick.role === input.role)
      rings.push({ role: pick.role, cost: point.cost, intelligence: point.intelligence });
  }

  return {
    points,
    series,
    frontier,
    lines: needLines(input.picks, input.role),
    rings,
    notOnChart,
    ticks: costTicks(Math.min(...drawn.map((p) => p.cost)), Math.max(...drawn.map((p) => p.cost))),
    omitted,
  };
}
