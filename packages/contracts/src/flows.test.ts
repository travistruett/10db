import { describe, expect, it } from 'vitest';
import { FlowInput } from './flows';

describe('FlowInput', () => {
  it.each([
    {
      name: 'a single implement step',
      input: { name: 'quick', steps: [{ role: 'implement', need: 40 }] },
      ok: true,
    },
    {
      name: 'steps with both skip rules and a named persona',
      input: {
        name: 'full',
        steps: [
          { role: 'plan', need: 45, skip: [{ kind: 'unless_criteria_over', count: 3 }] },
          { role: 'plan_review', need: 48, skip: [{ kind: 'unless_risk', tags: ['security'] }] },
          { role: 'implement', need: 40 },
          { role: 'review', need: 48, persona: 'security-reviewer' },
        ],
      },
      ok: true,
    },
    { name: 'no steps', input: { name: 'empty', steps: [] }, ok: false },
    {
      name: 'no implement step',
      input: { name: 'talk', steps: [{ role: 'review', need: 48 }] },
      ok: false,
    },
    {
      name: 'a review before any implement step',
      input: {
        name: 'backwards',
        steps: [
          { role: 'review', need: 48 },
          { role: 'implement', need: 40 },
        ],
      },
      ok: false,
    },
    {
      name: 'a skip rule on the implement step',
      input: {
        name: 'skippy',
        steps: [{ role: 'implement', need: 40, skip: [{ kind: 'unless_risk', tags: ['auth'] }] }],
      },
      ok: false,
    },
    {
      name: 'a need above 100',
      input: { name: 'big', steps: [{ role: 'implement', need: 101 }] },
      ok: false,
    },
    {
      name: 'an unless_risk rule with no tags',
      input: {
        name: 'bare',
        steps: [
          { role: 'implement', need: 40 },
          { role: 'review', need: 48, skip: [{ kind: 'unless_risk', tags: [] }] },
        ],
      },
      ok: false,
    },
    {
      name: 'a plan after the implement step',
      input: {
        name: 'late-plan',
        steps: [
          { role: 'implement', need: 40 },
          { role: 'plan', need: 45 },
        ],
      },
      ok: false,
    },
    {
      name: 'a persona key with capitals',
      input: { name: 'caps', steps: [{ role: 'implement', need: 40, persona: 'Implementer' }] },
      ok: false,
    },
  ])('$name', ({ input, ok }) => {
    expect(FlowInput.safeParse(input).success).toBe(ok);
  });
});
