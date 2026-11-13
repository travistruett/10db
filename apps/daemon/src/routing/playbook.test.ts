import {
  mintId,
  Rigor,
  StepRole,
  type CellSetting,
  type KindDto,
  type ModelSetting,
  type PersonaId,
  type TaskKind,
} from '@10db/contracts';
import type { PlaybookCellOverride, PlaybookOverrides, PlaybookRowOverride } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { resolveSteps, type PlaybookScopes } from './playbook';

const NONE: PlaybookOverrides = { rows: [], cells: [] };

const scopes = (
  global: Partial<PlaybookOverrides> = {},
  project: Partial<PlaybookOverrides> | null = null,
): PlaybookScopes => ({
  global: { ...NONE, ...global },
  project: project === null ? null : { ...NONE, ...project },
});

const row = (rigor: Rigor, ...steps: StepRole[]): PlaybookRowOverride => ({ rigor, steps });
const cell = (
  rigor: Rigor,
  role: StepRole,
  fields: Partial<CellSetting>,
): PlaybookCellOverride => ({
  rigor,
  role,
  personaId: null,
  model: null,
  effort: null,
  ...fields,
});

const kind = (key: string, fields: Partial<KindDto> = {}): KindDto => ({
  id: mintId('Kind'),
  key,
  label: key,
  description: '',
  minimumRigor: null,
  alwaysReviewed: false,
  failsAtLimit: false,
  ownCopy: false,
  toInbox: false,
  addsSteps: [],
  overrides: {},
  position: 0,
  ...fields,
});

const taskKinds = (...keys: string[]): TaskKind[] => keys.map((key) => ({ key, source: 'agent' }));
const override = (fields: Partial<CellSetting>): CellSetting => ({
  personaId: null,
  model: null,
  effort: null,
  ...fields,
});
const frontier: ModelSetting = { kind: 'tier', tier: 'frontier' };

const resolve = (
  rigor: Rigor,
  playbook: PlaybookScopes,
  kinds: KindDto[] = [],
  keys: string[] = [],
) => resolveSteps({ rigor, taskKinds: taskKinds(...keys), kinds, playbook });
const roles = (steps: { role: StepRole }[]) => steps.map((s) => s.role);

describe('resolveSteps: which steps run', () => {
  it.each([
    {
      name: 'a default row',
      rigor: Rigor.Careful,
      playbook: scopes(),
      want: ['plan', 'implement', 'review'],
    },
    {
      name: 'a global row over the default',
      rigor: Rigor.Light,
      playbook: scopes({ rows: [row(Rigor.Light, StepRole.Implement, StepRole.Review)] }),
      want: ['implement', 'review'],
    },
    {
      name: 'a project row over a global one',
      rigor: Rigor.Light,
      playbook: scopes(
        { rows: [row(Rigor.Light, StepRole.Implement, StepRole.Review)] },
        { rows: [row(Rigor.Light, StepRole.Implement, StepRole.Qa)] },
      ),
      want: ['implement', 'qa'],
    },
    {
      name: 'a row for another rigor is left alone',
      rigor: Rigor.Standard,
      playbook: scopes({ rows: [row(Rigor.Light, StepRole.Implement, StepRole.Qa)] }),
      want: ['implement', 'review'],
    },
    {
      name: 'steps in role order whatever the row lists',
      rigor: Rigor.Light,
      playbook: scopes({
        rows: [row(Rigor.Light, StepRole.Qa, StepRole.Implement, StepRole.Plan)],
      }),
      want: ['plan', 'implement', 'qa'],
    },
  ])('$name', ({ rigor, playbook, want }) => {
    expect(roles(resolve(rigor, playbook))).toEqual(want);
  });

  it('adds a kind’s steps in role order, once however many kinds add it', () => {
    const kinds = [
      kind('migration', { addsSteps: [StepRole.PlanReview] }),
      kind('other', { addsSteps: [StepRole.PlanReview, StepRole.Qa] }),
    ];
    expect(roles(resolve(Rigor.Careful, scopes(), kinds, ['migration', 'other']))).toEqual([
      'plan',
      'plan_review',
      'implement',
      'review',
      'qa',
    ]);
  });

  it('leaves out a plan review that has no plan to judge', () => {
    const kinds = [kind('migration', { addsSteps: [StepRole.PlanReview] })];
    expect(roles(resolve(Rigor.Standard, scopes(), kinds, ['migration']))).toEqual([
      'implement',
      'review',
    ]);
  });

  it('ignores a kind key no kind has', () => {
    expect(roles(resolve(Rigor.Light, scopes(), [], ['gone']))).toEqual(['implement']);
  });
});

describe('resolveSteps: what a step gets', () => {
  const step = (
    rigor: Rigor,
    role: StepRole,
    playbook = scopes(),
    kinds: KindDto[] = [],
    keys: string[] = [],
  ) => {
    const found = resolve(rigor, playbook, kinds, keys).find((s) => s.role === role);
    if (!found) throw new Error(`no ${role} step`);
    return found;
  };

  it('starts from the default cell: its minimum as the need, its fallback rung, no pin', () => {
    expect(step(Rigor.Standard, StepRole.Review)).toEqual({
      role: 'review',
      personaId: null,
      requirements: [{ kind: 'automatic', minimum: 40 }],
      effort: null,
      need: 40,
      fallback: { tier: 'capable', top: false, effort: 'high' },
      pinned: false,
    });
  });

  it('takes each field of a cell from the first scope that sets it', () => {
    const persona = mintId('Persona');
    const got = step(
      Rigor.Standard,
      StepRole.Review,
      scopes(
        {
          cells: [
            cell(Rigor.Standard, StepRole.Review, { effort: 'low', personaId: mintId('Persona') }),
          ],
        },
        { cells: [cell(Rigor.Standard, StepRole.Review, { personaId: persona })] },
      ),
    );
    expect(got.effort).toBe('low');
    expect(got.personaId).toBe(persona);
    expect(got.requirements).toEqual([{ kind: 'automatic', minimum: 40 }]);
  });

  it('routes at a builder’s own lower minimum', () => {
    const got = step(
      Rigor.Light,
      StepRole.Implement,
      scopes({
        cells: [
          cell(Rigor.Light, StepRole.Implement, { model: { kind: 'automatic', minimum: 30 } }),
        ],
      }),
    );
    expect(got.need).toBe(30);
  });

  it.each([
    { name: 'a tier', model: { kind: 'tier', tier: 'efficient' } },
    { name: 'a top of tier', model: { kind: 'top_of_tier' } },
    { name: 'automatic with no minimum', model: { kind: 'automatic' } },
  ] as const)('keeps the default minimum as the need under $name', ({ model }) => {
    const got = step(
      Rigor.Light,
      StepRole.Implement,
      scopes({ cells: [cell(Rigor.Light, StepRole.Implement, { model })] }),
    );
    expect(got.need).toBe(35);
    expect(got.requirements).toEqual([model]);
  });

  it('pins a step whose cell names one model, and no other', () => {
    const named = scopes({
      cells: [cell(Rigor.Light, StepRole.Implement, { model: { kind: 'model', model: 'mid' } })],
    });
    expect(step(Rigor.Light, StepRole.Implement, named).pinned).toBe(true);
    expect(step(Rigor.Light, StepRole.Implement).pinned).toBe(false);
  });

  it('adds a kind’s override model to the requirements and raises the effort, never lowers it', () => {
    const kinds = [
      kind('security', { overrides: { review: override({ model: frontier, effort: 'high' }) } }),
    ];
    const got = step(Rigor.Careful, StepRole.Review, scopes(), kinds, ['security']);
    expect(got.requirements).toEqual([{ kind: 'automatic', minimum: 48 }, frontier]);
    expect(got.effort).toBe('high');
    const lower = step(
      Rigor.Careful,
      StepRole.Review,
      scopes({ cells: [cell(Rigor.Careful, StepRole.Review, { effort: 'max' })] }),
      kinds,
      ['security'],
    );
    expect(lower.effort).toBe('max');
  });

  it('needs the highest of the cell’s minimum and every override’s', () => {
    const kinds = [
      kind('a', { overrides: { review: override({ model: { kind: 'automatic', minimum: 60 } }) } }),
      kind('b', { overrides: { review: override({ model: { kind: 'automatic', minimum: 55 } }) } }),
    ];
    expect(step(Rigor.Careful, StepRole.Review, scopes(), kinds, ['a', 'b']).need).toBe(60);
  });

  it('takes the persona of the first kind in the task’s order that names one', () => {
    const [first, second] = [mintId('Persona'), mintId('Persona')];
    const kinds = [
      kind('a', { overrides: { review: override({ personaId: first }) } }),
      kind('b', { overrides: { review: override({ personaId: second }) } }),
    ];
    const cellPersona: PersonaId = mintId('Persona');
    const playbook = scopes({
      cells: [cell(Rigor.Standard, StepRole.Review, { personaId: cellPersona })],
    });
    expect(step(Rigor.Standard, StepRole.Review, playbook, kinds, ['b', 'a']).personaId).toBe(
      second,
    );
    expect(step(Rigor.Standard, StepRole.Review, playbook, kinds, []).personaId).toBe(cellPersona);
  });

  it('gives a step a kind added the cell of the lowest stronger rigor that runs the role', () => {
    const kinds = [
      kind('migration', {
        addsSteps: [StepRole.PlanReview],
        overrides: { plan_review: override({ model: frontier, effort: 'high' }) },
      }),
    ];
    const got = step(Rigor.Careful, StepRole.PlanReview, scopes(), kinds, ['migration']);
    expect(got.requirements).toEqual([{ kind: 'automatic', minimum: 52 }, frontier]);
    expect(got.need).toBe(52);
    expect(got.fallback).toEqual({ tier: 'capable', top: true, effort: 'xhigh' });
  });

  it('gives a kind’s override of a role the rigor does not run no step', () => {
    const kinds = [kind('security', { overrides: { qa: override({ effort: 'high' }) } })];
    expect(roles(resolve(Rigor.Careful, scopes(), kinds, ['security']))).not.toContain('qa');
  });
});
