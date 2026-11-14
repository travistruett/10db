import { DEFAULT_JUDGE_CONFIG, JudgeDecision, type JudgeConfig } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { decisionModelDto } from '../../test/judge-fixtures';
import { answersByModel, costAxis, decisionModelSeries, ringLabel } from './decision-model-series';

const model = (id: string, over: Parameters<typeof decisionModelDto>[0] = {}) =>
  decisionModelDto({ id, name: id, costPerMillionUsd: 2, secondsPerDecision: 1.5, ...over });

const config = (picks: Partial<Record<JudgeDecision, string>>): JudgeConfig => ({
  ...DEFAULT_JUDGE_CONFIG,
  decisions: Object.fromEntries(
    Object.entries(DEFAULT_JUDGE_CONFIG.decisions).map(([d, c]) => [
      d,
      { ...c, model: picks[d as JudgeDecision] ?? 'other/unused' },
    ]),
  ) as JudgeConfig['decisions'],
});

describe('decisionModelSeries', () => {
  it('draws a model with both numbers at its cost', () => {
    const { points, omitted, freeX } = decisionModelSeries([model('a/one')], config({}));
    expect(points).toMatchObject([{ id: 'a/one', x: 2, free: false, secondsPerDecision: 1.5 }]);
    expect(omitted).toBe(0);
    expect(freeX).toBeNull();
  });

  it('draws a free model at a quarter of the cheapest paid cost, marked free and not omitted', () => {
    const out = decisionModelSeries(
      [
        model('a/free', { costPerMillionUsd: 0 }),
        model('a/cheap', { costPerMillionUsd: 0.8 }),
        model('a/dear'),
      ],
      config({}),
    );
    expect(out.freeX).toBeCloseTo(0.2);
    expect(out.points.find((p) => p.id === 'a/free')).toMatchObject({ free: true, x: out.freeX });
    expect(out.omitted).toBe(0);
  });

  it('draws a free model at 0.01 when nothing is paid', () => {
    const out = decisionModelSeries([model('a/free', { costPerMillionUsd: 0 })], config({}));
    expect(out.freeX).toBe(0.01);
    expect(out.points[0]?.x).toBe(0.01);
  });

  it.each([
    { name: 'no cost', over: { costPerMillionUsd: null } },
    { name: 'no time', over: { secondsPerDecision: null } },
    { name: 'neither', over: { costPerMillionUsd: null, secondsPerDecision: null } },
  ])('leaves out a model with $name and counts it', ({ over }) => {
    const out = decisionModelSeries([model('a/one'), model('a/gap', over)], config({}));
    expect(out.points.map((p) => p.id)).toEqual(['a/one']);
    expect(out.omitted).toBe(1);
  });

  it('lists the decisions that use a model, from the config', () => {
    const { points } = decisionModelSeries(
      [model('a/one'), model('a/two')],
      config({ [JudgeDecision.ShapeReady]: 'a/one', [JudgeDecision.QuestionRoute]: 'a/one' }),
    );
    expect(points.find((p) => p.id === 'a/one')?.usedBy).toEqual([
      JudgeDecision.ShapeReady,
      JudgeDecision.QuestionRoute,
    ]);
    expect(points.find((p) => p.id === 'a/two')?.usedBy).toEqual([]);
  });

  it('draws a ~latest router and its target as two points', () => {
    const { points } = decisionModelSeries(
      [model('~a/one-latest', { latest: true }), model('a/one-2')],
      config({}),
    );
    expect(points.map((p) => p.id)).toEqual(['~a/one-latest', 'a/one-2']);
  });
});

describe('ringLabel', () => {
  it.each([
    {
      name: 'one decision names it',
      used: [JudgeDecision.ReviewSize],
      expected: 'Skip review for small changes',
    },
    {
      name: 'several decisions count',
      used: [JudgeDecision.ReviewSize, JudgeDecision.ShapeReady, JudgeDecision.ShapeRecord],
      expected: '3 decisions',
    },
  ])('$name', ({ used, expected }) => {
    expect(ringLabel(used)).toBe(expected);
  });
});

describe('costAxis', () => {
  it('has no tick at or left of Free, and starts at it', () => {
    const axis = costAxis([0.25, 2, 40], 0.25);
    expect(axis?.domain[0]).toBe(0.25);
    expect(axis?.ticks[0]).toBe(0.25);
    expect(axis?.ticks.filter((t) => t <= 0.25)).toEqual([0.25]);
  });

  it('is the 1-2-5 ladder around the costs when nothing is free', () => {
    const axis = costAxis([2, 40], null);
    expect(axis?.ticks).toEqual([2, 5, 10, 20, 50]);
    expect(axis?.domain).toEqual([2, 50]);
  });

  it('is null with nothing drawn', () => {
    expect(costAxis([], null)).toBeNull();
  });
});

describe('answersByModel', () => {
  it('counts the answers each model gave across decisions', () => {
    const stats = {
      since: '2026-10-14T12:00:00.000Z',
      decisions: [
        { ...base(JudgeDecision.ReviewSize), answers: [ans('a/one'), ans('a/one'), ans('a/two')] },
        { ...base(JudgeDecision.ShapeReady), answers: [ans('a/one')] },
      ],
    };
    expect([...answersByModel(stats)]).toEqual([
      ['a/one', 3],
      ['a/two', 1],
    ]);
  });
});

const NO_CALLS = 0;
const NO_TIMEOUTS = 0;
const ans = (m: string) => ({ model: m, confidence: 0.9 });
const base = (decision: JudgeDecision) => ({
  decision,
  calls: NO_CALLS,
  acted: NO_CALLS,
  belowFloor: NO_CALLS,
  shadow: NO_CALLS,
  stopped: NO_CALLS,
  fallbacks: { off: NO_CALLS, no_key: NO_CALLS, timeout: NO_TIMEOUTS, error: NO_CALLS },
  costUsd: 0,
  medianLatencyMs: null,
});
