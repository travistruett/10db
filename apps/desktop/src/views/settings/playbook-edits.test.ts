import { StepRole, type PlaybookCellDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { isEmptyCell, noneLabels, ownCell, processLine, toggleStep } from './playbook-edits';
import { personaDto, playbookDto } from '../../test/playbook-fixtures';

const cell = (over: Partial<PlaybookCellDto>): PlaybookCellDto => ({
  rigor: 'standard',
  role: 'review',
  personaId: { value: null, source: 'default' },
  model: { value: { kind: 'automatic', minimum: 40 }, source: 'default' },
  effort: { value: null, source: 'default' },
  ...over,
});

describe('ownCell', () => {
  it.each([
    {
      name: 'global scope keeps its own fields and drops the default ones',
      source: 'global' as const,
      cell: cell({ effort: { value: 'low', source: 'global' } }),
      want: { personaId: null, model: null, effort: 'low' },
    },
    {
      name: 'project scope drops a field the global scope set',
      source: 'project' as const,
      cell: cell({
        effort: { value: 'low', source: 'global' },
        model: { value: { kind: 'tier', tier: 'capable' }, source: 'project' },
      }),
      want: { personaId: null, model: { kind: 'tier', tier: 'capable' }, effort: null },
    },
    {
      name: 'global scope drops a field a project set',
      source: 'global' as const,
      cell: cell({ effort: { value: 'max', source: 'project' } }),
      want: { personaId: null, model: null, effort: null },
    },
  ])('$name', ({ source, cell: c, want }) => {
    expect(ownCell(c, source)).toEqual(want);
  });

  it('is empty when the scope sets nothing, so a Reset has nothing left to clear', () => {
    expect(isEmptyCell(ownCell(cell({}), 'global'))).toBe(true);
    expect(
      isEmptyCell(ownCell(cell({ effort: { value: 'low', source: 'global' } }), 'global')),
    ).toBe(false);
  });
});

describe('toggleStep', () => {
  const { Plan, PlanReview, Implement, Review, Qa } = StepRole;
  it.each([
    {
      name: 'adds a step in task order',
      from: [Implement],
      role: Review,
      on: true,
      want: [Implement, Review],
    },
    {
      name: 'removes a step',
      from: [Implement, Review],
      role: Review,
      on: false,
      want: [Implement],
    },
    {
      name: 'never removes Build',
      from: [Implement, Review],
      role: Implement,
      on: false,
      want: [Implement, Review],
    },
    {
      name: 'brings the plan with a plan review',
      from: [Implement],
      role: PlanReview,
      on: true,
      want: [Plan, PlanReview, Implement],
    },
    {
      name: 'takes the plan review with the plan',
      from: [Plan, PlanReview, Implement],
      role: Plan,
      on: false,
      want: [Implement],
    },
    {
      name: 'puts QA last',
      from: [Qa, Implement],
      role: Review,
      on: true,
      want: [Implement, Review, Qa],
    },
  ])('$name', ({ from, role, on, want }) => {
    expect(toggleStep(from, role, on)).toEqual(want);
  });
});

describe('noneLabels', () => {
  const reviewer = personaDto({ key: 'reviewer-b', role: 'review', name: 'Reviewer B' });
  const base = { personas: [reviewer], names: new Map<string, string>() };

  it.each([
    {
      name: 'an unset global cell says what the default is',
      projectId: null,
      cell: cell({}),
      globalCell: null,
      want: {
        persona: 'Default: the role’s own',
        model: 'Default: Automatic, at least 40',
        effort: 'Default: Automatic',
        minimumPlaceholder: 'Default 40',
      },
    },
    {
      name: 'a set global field hides the default under it',
      projectId: null,
      cell: cell({
        model: { value: { kind: 'tier', tier: 'capable' }, source: 'global' },
        effort: { value: 'low', source: 'global' },
      }),
      globalCell: null,
      want: {
        persona: 'Default: the role’s own',
        model: 'Default',
        effort: 'Default',
        minimumPlaceholder: 'No minimum',
      },
    },
    {
      name: 'a project names what the global playbook sets',
      projectId: 'prj_1',
      cell: cell({}),
      globalCell: cell({
        personaId: { value: reviewer.id, source: 'global' },
        model: { value: { kind: 'top_of_tier', tier: 'frontier' }, source: 'global' },
        effort: { value: 'xhigh', source: 'global' },
      }),
      want: {
        persona: 'Global: Reviewer B',
        model: 'Global: Top of Frontier',
        effort: 'Global: Extra High',
        minimumPlaceholder: 'No minimum',
      },
    },
  ])('$name', ({ projectId, cell: c, globalCell, want }) => {
    expect(noneLabels({ projectId, cell: c, globalCell, ...base })).toEqual(want);
  });
});

describe('processLine', () => {
  const row = (rigor: 'light' | 'standard' | 'careful' | 'critical') => {
    const found = playbookDto().rows.find((r) => r.rigor === rigor);
    if (!found) throw new Error(`no ${rigor} row`);
    return found;
  };
  it.each([
    { name: 'Light has no review', row: row('light'), want: 'no review' },
    { name: 'Standard resumes its fix', row: row('standard'), want: '1 round · resumed fix' },
    { name: 'Careful uses a fresh fix', row: row('careful'), want: '2 rounds · fresh fix' },
    {
      name: 'Critical asks the builder to approve the plan',
      row: row('critical'),
      want: '2 rounds · fresh fix · you approve the plan',
    },
    {
      name: 'a row with no review but a plan approval keeps the approval',
      row: {
        ...row('careful'),
        steps: { value: [StepRole.Plan, StepRole.Implement], source: 'global' as const },
        approvesPlan: { value: true, source: 'global' as const },
      },
      want: 'no review · you approve the plan',
    },
    {
      name: 'an approval without a plan step is not shown',
      row: {
        ...row('critical'),
        steps: { value: [StepRole.Implement, StepRole.Review], source: 'global' as const },
      },
      want: '2 rounds · fresh fix',
    },
    {
      name: 'zero rounds',
      row: { ...row('standard'), reviewRounds: { value: 0, source: 'project' as const } },
      want: '0 rounds · resumed fix',
    },
  ])('$name', ({ row: r, want }) => {
    expect(processLine(r)).toBe(want);
  });
});
