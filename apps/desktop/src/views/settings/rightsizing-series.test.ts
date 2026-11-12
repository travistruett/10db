import type { ModelRowDto, RolePickDto, StepRole } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { modelEffortDto, modelRowDto } from '../../test/model-fixtures';
import { DotsMode, rightsizingSeries } from './rightsizing-series';

const effort = (
  name: 'low' | 'medium' | 'high',
  intelligence: number | null,
  cost: number | null,
) => modelEffortDto({ effort: name, intelligence, costPerTaskUsd: cost });

const row = (model: string, tier: ModelRowDto['tier'], efforts: ReturnType<typeof effort>[]) =>
  modelRowDto({ model, name: model.toUpperCase(), tier, efforts });

const small = row('small', 'fast', [effort('low', 20, 0.05), effort('high', 30, 0.4)]);
const mid = row('mid', 'balanced', [effort('low', 38, 0.4), effort('high', 46, 1)]);
const big = row('big', 'strongest', [effort('high', 50, 2)]);
const unmeasured = row('plain', null, [effort('high', null, null)]);
const free = row('free', 'fast', [effort('high', 40, 0)]);

const NEEDS: Record<StepRole, number> = {
  plan: 45,
  plan_review: 48,
  implement: 40,
  review: 48,
  qa: 35,
};
const pickOf = (role: StepRole, from: ModelRowDto | null, at: number): RolePickDto => {
  const chosen = from?.efforts[at];
  return {
    role,
    need: NEEDS[role],
    profileId: chosen?.profileId ?? null,
    model: from?.model ?? null,
    effort: chosen?.effort ?? null,
    intelligence: chosen?.intelligence ?? null,
    costPerTaskUsd: chosen?.costPerTaskUsd ?? null,
    reason: 'by score',
  };
};
const PICKS = [
  pickOf('plan', mid, 1),
  pickOf('plan_review', big, 0),
  pickOf('implement', mid, 1),
  pickOf('review', big, 0),
  pickOf('qa', mid, 0),
];

const build = (over: Partial<Parameters<typeof rightsizingSeries>[0]> = {}) =>
  rightsizingSeries({
    rows: [small, mid, big],
    picks: PICKS,
    role: null,
    dots: DotsMode.Every,
    ...over,
  });

const drawn = (result: ReturnType<typeof build>) =>
  result.series
    .flatMap((s) => s.data.map((d) => result.points[d.id]))
    .map((p) => `${p?.model ?? '?'}@${p?.effort ?? '?'}`)
    .sort();

describe('rightsizingSeries points', () => {
  it('draws one point per measured effort, in a series per tier', () => {
    const result = build();
    expect(result.series.map((s) => [s.name, s.data.length])).toEqual([
      ['Fast', 2],
      ['Balanced', 2],
      ['Strongest', 1],
    ]);
    expect(result.omitted).toBe(0);
  });

  it('leaves out a point with no value or a cost of 0, and counts it', () => {
    const result = build({ rows: [small, unmeasured, free] });
    expect(drawn(result)).toEqual(['small@high', 'small@low']);
    expect(result.omitted).toBe(2);
  });

  it('keeps a model with no tier in a series of its own', () => {
    const noTier = row('plain', null, [effort('high', 33, 0.5)]);
    expect(build({ rows: [noTier] }).series.map((s) => s.name)).toEqual(['No tier']);
  });

  it('draws only the frontier in Pareto only, and keeps the points the picks stand on', () => {
    // small@high costs the same as mid@low and scores less; dom@high costs more than both and scores less.
    const dominated = row('dom', 'balanced', [effort('high', 25, 0.9)]);
    const rows = [small, mid, big, dominated];
    const bare = build({ rows, dots: DotsMode.Pareto, picks: [] });
    expect(drawn(bare)).toEqual(['big@high', 'mid@high', 'mid@low', 'small@low']);
    expect(bare.pareto.map((p) => `${p.model}@${p.effort}`)).toEqual([
      'small@low',
      'mid@low',
      'mid@high',
      'big@high',
    ]);
    const picked = build({ rows, dots: DotsMode.Pareto, picks: [pickOf('qa', dominated, 0)] });
    expect(drawn(picked)).toEqual(['big@high', 'dom@high', 'mid@high', 'mid@low', 'small@low']);
    expect(picked.rings.map((r) => r.role)).toEqual(['qa']);
  });
});

describe('rightsizingSeries need lines', () => {
  it('draws a line per distinct need, merging roles that share one', () => {
    expect(build().lines.map((l) => [l.label, l.need])).toEqual([
      ['Plan 45', 45],
      ['Plan review, Review 48', 48],
      ['Build 40', 40],
      ['QA 35', 35],
    ]);
  });

  it('draws only the selected role’s line', () => {
    expect(build({ role: 'implement' }).lines.map((l) => l.label)).toEqual(['Build 40']);
  });
});

describe('rightsizingSeries rings and area', () => {
  it('rings the point each pick stands on, found by its profile', () => {
    const result = build();
    const plan = result.rings.find((r) => r.role === 'plan');
    expect(plan).toMatchObject({ cost: 1, intelligence: 46, dimmed: false });
    expect(result.rings).toHaveLength(5);
    expect(result.notOnChart).toEqual([]);
  });

  it('dims the other rings when a role is selected', () => {
    const result = build({ role: 'review' });
    expect(result.rings.map((r) => [r.role, r.dimmed])).toEqual([
      ['plan', true],
      ['plan_review', true],
      ['implement', true],
      ['review', false],
      ['qa', true],
    ]);
  });

  it('puts no ring on a point that is not drawn, and says so', () => {
    // The pick's effort has no cost to place it by; a pick of nothing has no profile.
    const priceless = row('priceless', 'balanced', [effort('high', 44, null)]);
    const result = build({
      picks: [pickOf('plan', priceless, 0), pickOf('qa', null, 0), pickOf('review', big, 0)],
    });
    expect(result.rings.map((r) => r.role)).toEqual(['review']);
    expect(result.notOnChart).toEqual(['plan', 'qa']);
  });

  it('puts no ring on a point a filter hid', () => {
    const result = build({ rows: [small, mid] });
    expect(result.notOnChart).toEqual(['plan_review', 'review']);
  });

  it('shades from the lowest need up to the dearest drawn pick', () => {
    expect(build().area).toEqual({ need: 35, cost: 2 });
  });

  it('takes the area from the drawn picks only', () => {
    expect(build({ rows: [small, mid] }).area).toEqual({ need: 35, cost: 1 });
  });

  it('shades from the selected role’s need to its pick’s cost', () => {
    expect(build({ role: 'implement' }).area).toEqual({ need: 40, cost: 1 });
  });

  it('shades nothing where no pick is drawn', () => {
    expect(build({ rows: [], picks: PICKS }).area).toBeNull();
    expect(build({ picks: [] }).area).toBeNull();
  });
});

describe('rightsizingSeries identity', () => {
  it('numbers points so the chart can look a point up by its id', () => {
    const result = build();
    const ids = result.series.flatMap((s) => s.data.map((d) => d.id));
    expect(ids.sort()).toEqual(result.points.map((p) => p.id).sort());
    expect(result.points.every((p, i) => p.id === i)).toBe(true);
  });
});
