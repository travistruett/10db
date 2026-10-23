import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { projectDto } from '../../test/fixtures';
import { checkGeneral, generalValues, type GeneralValues } from './general-values';

const project = projectDto({ name: 'demo', gateCommand: 'make gate', budgetCeiling: null });
const base = generalValues(project);
const flowId = mintId('Flow');

describe('checkGeneral', () => {
  it.each<{
    name: string;
    change: Partial<GeneralValues>;
    expected: ReturnType<typeof checkGeneral>;
  }>([
    { name: 'nothing changed', change: {}, expected: { ok: true, patch: null } },
    {
      name: 'a new name, trimmed',
      change: { name: '  demo2 ' },
      expected: { ok: true, patch: { name: 'demo2' } },
    },
    {
      name: 'a ceiling',
      change: { budgetCeiling: 2.5 },
      expected: { ok: true, patch: { budgetCeiling: 2.5 } },
    },
    { name: 'a flow', change: { flowId }, expected: { ok: true, patch: { flowId } } },
    {
      name: 'the lane cap and wait',
      change: { maxLanes: 4, humanWaitMinutes: 30 },
      expected: { ok: true, patch: { maxLanes: 4, humanWaitMinutes: 30 } },
    },
    {
      name: 'an empty name',
      change: { name: ' ' },
      expected: { ok: false, errors: { name: 'Enter a name' } },
    },
    {
      name: 'an empty gate',
      change: { gateCommand: '' },
      expected: { ok: false, errors: { gateCommand: 'Enter the gate command' } },
    },
    {
      name: 'an empty lane cap',
      change: { maxLanes: '' },
      expected: { ok: false, errors: { maxLanes: 'Enter the lane cap' } },
    },
    {
      name: 'an empty handoff',
      change: { handoffPct: '' },
      expected: { ok: false, errors: { handoffPct: 'Enter the handoff percentage' } },
    },
    {
      name: 'a nudge at the handoff',
      change: { handoffPct: 50, nudgePct: 50 },
      expected: { ok: false, errors: { nudgePct: 'The nudge must come after the handoff' } },
    },
    {
      name: 'a zero ceiling',
      change: { budgetCeiling: 0 },
      expected: {
        ok: false,
        errors: { budgetCeiling: 'Enter a ceiling above $0, or leave it empty for none' },
      },
    },
    {
      name: 'pull-request delivery with a prefix, trimmed',
      change: { delivery: 'pull_request', prTitlePrefix: ' feat(app) ' },
      expected: { ok: true, patch: { delivery: 'pull_request', prTitlePrefix: 'feat(app)' } },
    },
    {
      name: 'pull-request delivery without a prefix',
      change: { delivery: 'pull_request' },
      expected: {
        ok: false,
        errors: { prTitlePrefix: 'Enter a PR title prefix such as feat(app)' },
      },
    },
    {
      name: 'a prefix that is not a Conventional Commit type',
      change: { prTitlePrefix: 'Feature' },
      expected: {
        ok: false,
        errors: { prTitlePrefix: 'Enter a PR title prefix such as feat(app)' },
      },
    },
    {
      name: 'a new base branch',
      change: { baseBranch: 'develop' },
      expected: { ok: true, patch: { baseBranch: 'develop' } },
    },
    {
      name: 'a base branch that is an option',
      change: { baseBranch: '-x' },
      expected: { ok: false, errors: { baseBranch: 'Enter the base branch, such as main' } },
    },
  ])('answers $name', ({ change, expected }) => {
    expect(checkGeneral(project, { ...base, ...change })).toEqual(expected);
  });

  it('clears a ceiling when the field is emptied', () => {
    const capped = projectDto({ budgetCeiling: 3 });
    expect(checkGeneral(capped, { ...generalValues(capped), budgetCeiling: '' })).toEqual({
      ok: true,
      patch: { budgetCeiling: null },
    });
  });

  it('clears a prefix when the field is emptied in local delivery', () => {
    const prefixed = projectDto({ prTitlePrefix: 'feat(app)' });
    expect(checkGeneral(prefixed, { ...generalValues(prefixed), prTitlePrefix: '' })).toEqual({
      ok: true,
      patch: { prTitlePrefix: null },
    });
  });
});
