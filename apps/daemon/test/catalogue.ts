import type { Effort } from '@10db/contracts';
import { applyAaMeasurement, listModelProfiles } from '@10db/db';
import type { StateStore } from '../src/events';

/** Score base, cost per task and speed by model alias. */
const BASE: Readonly<Record<string, readonly [number, number, number]>> = {
  haiku: [20, 0.05, 200],
  sonnet: [35, 0.3, 100],
  opus: [45, 1, 50],
  fable: [50, 2, 40],
};
/** Score bonus and cost multiplier by effort. */
const EFFORT: Readonly<Record<Effort, readonly [number, number]>> = {
  low: [0, 1],
  medium: [3, 1.5],
  high: [6, 2.5],
  xhigh: [8, 4],
  max: [10, 6],
};

/** Invented measurements for the seeded catalogue: deterministic routing in tests, and never AA's numbers. */
export function measureForTests(state: StateStore): void {
  state.write((ctx) => {
    for (const p of listModelProfiles(ctx.tx)) {
      const model = BASE[p.model];
      if (!model) continue;
      const [base, cost, tps] = model;
      const [bonus, mult] = EFFORT[p.effort];
      const score = base + bonus;
      applyAaMeasurement(ctx, p.id, {
        scores: { intelligence: score, coding: score, agentic: score },
        costPerTaskUsd: cost * mult,
        outputTokensPerSecond: tps,
        indexVersion: 'test',
        measuredAt: ctx.now,
      });
    }
  });
}
