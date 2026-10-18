import type { SkipRule } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { stepFloor } from './floors';
import { skipReason, type TaskShape } from './skip-rules';

describe('stepFloor', () => {
  it.each([
    { role: 'review', tags: ['security'], minimum: 52 },
    { role: 'plan_review', tags: ['auth'], minimum: 52 },
    { role: 'review', tags: ['dependency'], minimum: 0 },
    { role: 'implement', tags: ['migration'], minimum: 45 },
    { role: 'implement', tags: ['security'], minimum: 0 },
    { role: 'qa', tags: ['security', 'migration'], minimum: 0 },
    { role: 'review', tags: [], minimum: 0 },
  ] as const)('$role with $tags needs at least $minimum', ({ role, tags, minimum }) => {
    expect(stepFloor(role, tags).minimum).toBe(minimum);
  });
});

describe('skipReason', () => {
  const task = (riskTags: ('security' | 'auth')[], criteria: number) => ({
    riskTags,
    acceptanceCriteria: Array.from({ length: criteria }, (_, i) => `criterion ${String(i)}`),
  });
  const rows: { name: string; skip: SkipRule[]; t: TaskShape; skipped: boolean }[] = [
    { name: 'a step with no rules runs', skip: [], t: task([], 1), skipped: false },
    {
      name: 'unless_risk runs when a tag matches',
      skip: [{ kind: 'unless_risk', tags: ['security'] }],
      t: task(['security'], 1),
      skipped: false,
    },
    {
      name: 'unless_risk skips when none matches',
      skip: [{ kind: 'unless_risk', tags: ['security'] }],
      t: task(['auth'], 1),
      skipped: true,
    },
    {
      name: 'unless_criteria_over runs above the count',
      skip: [{ kind: 'unless_criteria_over', count: 3 }],
      t: task([], 4),
      skipped: false,
    },
    {
      name: 'unless_criteria_over skips at the count',
      skip: [{ kind: 'unless_criteria_over', count: 3 }],
      t: task([], 3),
      skipped: true,
    },
    {
      name: 'two rules run when either holds',
      skip: [
        { kind: 'unless_risk', tags: ['auth'] },
        { kind: 'unless_criteria_over', count: 3 },
      ],
      t: task(['auth'], 1),
      skipped: false,
    },
  ];
  it.each(rows)('$name', ({ skip, t, skipped }) => {
    expect(skipReason({ role: 'review', need: 48, skip, persona: null }, t) !== null).toBe(skipped);
  });
});
