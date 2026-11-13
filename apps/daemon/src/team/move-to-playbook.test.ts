import {
  PlaybookMoveEntry,
  type FlowInput,
  type ModelSetting,
  type PersonaId,
  type ProjectDto,
  type Rigor,
  type RiskTag,
  type StepRole,
  type TaskDto,
} from '@10db/contracts';
import {
  createTestStore,
  findPersonaByKey,
  getAppSetting,
  getPlaybook,
  getTask,
  getProject,
  insertFlow,
  insertPersona,
  insertTask,
  listFlows,
  listInbox,
  listKinds,
  patchPersona,
  patchProject,
  seedProject,
  setPatterns,
  setRoleSetting,
  setTeam,
  type NewPattern,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { moveToPlaybook } from './move-to-playbook';
import { seedTeam } from './seed';

let state: StateStore;
let close: () => void;
let project: (name: string) => ProjectDto;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  project = (name) => seedProject(test.store, { name });
});
afterEach(() => {
  close();
});

const run = () => state.write((ctx) => moveToPlaybook(ctx));
const personaId = (key: string): PersonaId => {
  const found = findPersonaByKey(state.db, key);
  if (!found) throw new Error(`no persona ${key}`);
  return found.id;
};
const flowId = (name: string) => {
  const found = listFlows(state.db).find((f) => f.name === name);
  if (!found) throw new Error(`no flow ${name}`);
  return found.id;
};
const RIGORS: readonly Rigor[] = ['light', 'standard', 'careful', 'critical'];

/** One cell's three fields at a scope, null where the scope leaves the field alone. */
const cell = (scope: ProjectDto | null, rigor: Rigor, role: StepRole) => {
  const found = getPlaybook(state.db, scope?.id ?? null).cells.find(
    (c) => c.rigor === rigor && c.role === role,
  );
  return found
    ? { personaId: found.personaId, model: found.model, effort: found.effort }
    : { personaId: null, model: null, effort: null };
};
/** A role's cell model at every rigor, so a setting that must apply to all four is one assertion. */
const modelsOf = (scope: ProjectDto | null, role: StepRole) =>
  RIGORS.map((rigor) => cell(scope, rigor, role).model);
const all = (setting: ModelSetting | null) => RIGORS.map(() => setting);

const newTask = (
  p: ProjectDto,
  extra: { flow?: string; riskTags?: RiskTag[]; title?: string } = {},
): TaskDto =>
  state.write((ctx) =>
    insertTask(ctx, p.id, {
      title: extra.title ?? 'A task',
      acceptanceCriteria: ['Works'],
      areas: ['api'],
      riskTags: extra.riskTags ?? [],
      flowId: extra.flow === undefined ? null : flowId(extra.flow),
    }),
  );

const addFlow = (name: string, steps: FlowInput['steps']) =>
  state.write((ctx) => insertFlow(ctx, { name, steps }));
const addPersona = (key: string, role: StepRole, pin?: { model: string; effort: 'low' | 'high' }) =>
  state.write((ctx) =>
    insertPersona(ctx, {
      key,
      name: key,
      role,
      tools: role === 'implement' ? 'edit' : 'read_only',
      instructions: 'Do it.',
      ...(pin ? { modelPin: pin } : {}),
    }),
  );
const setting = (role: StepRole, projectId: ProjectDto | null, value: ModelSetting) => {
  state.write((ctx) => {
    setRoleSetting(ctx, { role, projectId: projectId?.id ?? null, setting: value });
  });
};
const patterns = (scope: ProjectDto | null, list: NewPattern[]) => {
  state.write((ctx) => {
    setPatterns(ctx, scope?.id ?? null, list);
  });
};
const pattern = (
  name: string,
  match: Partial<NewPattern['match']>,
  value: ModelSetting,
): NewPattern => ({
  name,
  match: { roles: [], riskTags: [], areas: [], retryOnly: false, ...match },
  setting: value,
});
const capable: ModelSetting = { kind: 'tier', tier: 'capable' };
const frontier: ModelSetting = { kind: 'tier', tier: 'frontier' };
const balanced: ModelSetting = { kind: 'tier', tier: 'balanced' };

describe('moveToPlaybook: flows become rigor', () => {
  it.each([
    { name: 'quick', steps: undefined, rigor: 'light' },
    { name: 'standard', steps: undefined, rigor: 'standard' },
    { name: 'full', steps: undefined, rigor: 'careful' },
    {
      name: 'a custom flow with a plan step',
      steps: [
        { role: 'plan', need: 40 },
        { role: 'implement', need: 40 },
        { role: 'review', need: 40 },
      ],
      rigor: 'careful',
    },
    {
      name: 'a custom flow with a review and no plan',
      steps: [
        { role: 'implement', need: 40 },
        { role: 'review', need: 40 },
      ],
      rigor: 'standard',
    },
    {
      name: 'a custom flow that only implements',
      steps: [{ role: 'implement', need: 40 }],
      rigor: 'light',
    },
  ] as const)('$name makes a task and a project $rigor', ({ name, steps, rigor }) => {
    const flow = steps ? `custom-${name.split(' ').length.toString()}-${rigor}` : name;
    if (steps) addFlow(flow, [...steps]);
    const p = project('demo');
    state.write((ctx) => {
      patchProject(ctx, p.id, { flowId: flowId(flow) });
    });
    const task = newTask(p, { flow });
    run();
    expect(getTask(state.db, task.id).rigor).toBe(rigor);
    expect(getProject(state.db, p.id).defaultRigor).toBe(rigor);
  });

  it('leaves a task and a project with no flow on the project default', () => {
    const p = project('demo');
    const task = newTask(p);
    run();
    expect(getTask(state.db, task.id).rigor).toBeNull();
    expect(getProject(state.db, p.id).defaultRigor).toBe('standard');
  });
});

describe('moveToPlaybook: risk tags become kinds', () => {
  it.each([
    {
      name: 'a quick security task is raised to careful',
      flow: 'quick',
      tags: ['security'],
      rigor: 'careful',
    },
    {
      name: 'a quick dependency task is raised to standard',
      flow: 'quick',
      tags: ['dependency'],
      rigor: 'standard',
    },
    {
      name: 'a full migration task stays careful',
      flow: 'full',
      tags: ['migration'],
      rigor: 'careful',
    },
    {
      name: 'a standard task keeps standard under a lower minimum',
      flow: 'standard',
      tags: ['dependency'],
      rigor: 'standard',
    },
    {
      name: 'two tags take the strongest minimum',
      flow: 'quick',
      tags: ['dependency', 'auth'],
      rigor: 'careful',
    },
    {
      name: 'a task with no flow is raised to the minimum',
      flow: undefined,
      tags: ['auth'],
      rigor: 'careful',
    },
    {
      name: 'a task with no flow and no raise keeps following the project',
      flow: undefined,
      tags: ['dependency'],
      rigor: null,
    },
  ] as const)('$name', ({ flow, tags, rigor }) => {
    const p = project('demo');
    const task = newTask(p, { ...(flow ? { flow } : {}), riskTags: [...tags] });
    run();
    const moved = getTask(state.db, task.id);
    expect(moved.rigor).toBe(rigor);
    expect(moved.kinds).toEqual(tags.map((key) => ({ key, source: 'builder' })));
  });
});

describe('moveToPlaybook: role settings', () => {
  it('puts a global setting in that role’s cell at every rigor, and a project’s at its scope', () => {
    const p = project('demo');
    setting('review', null, capable);
    setting('implement', null, { kind: 'automatic', minimum: 55 });
    setting('implement', p, { kind: 'model', model: 'test-model' });
    run();
    expect(modelsOf(null, 'review')).toEqual(all(capable));
    expect(modelsOf(null, 'implement')).toEqual(all({ kind: 'automatic', minimum: 55 }));
    expect(modelsOf(p, 'implement')).toEqual(all({ kind: 'model', model: 'test-model' }));
    expect(modelsOf(p, 'review')).toEqual(all(null));
    expect(modelsOf(null, 'plan')).toEqual(all(null));
  });

  it('keeps no minimum the setting did not have', () => {
    setting('implement', null, { kind: 'automatic' });
    run();
    expect(modelsOf(null, 'implement')).toEqual(all({ kind: 'automatic' }));
  });
});

describe('moveToPlaybook: team bindings', () => {
  it('binds a project’s persona into that role’s cell at every rigor, for that project only', () => {
    const p = project('demo');
    const other = project('other');
    const deep = addPersona('deep-reviewer', 'review');
    state.write((ctx) => {
      setTeam(ctx, p.id, { bindings: [{ role: 'review', personaId: deep.id }], members: [] });
    });
    run();
    expect(RIGORS.map((r) => cell(p, r, 'review').personaId)).toEqual(RIGORS.map(() => deep.id));
    expect(RIGORS.map((r) => cell(other, r, 'review').personaId)).toEqual(RIGORS.map(() => null));
    expect(RIGORS.map((r) => cell(null, r, 'review').personaId)).toEqual(RIGORS.map(() => null));
  });
});

describe('moveToPlaybook: a persona’s pin and minimum', () => {
  const pin = { model: 'test-model', effort: 'low' } as const;
  const pinned = { kind: 'model', model: 'test-model' } as const;

  it('lets the default persona’s pin beat the global role setting, model and effort', () => {
    setting('implement', null, capable);
    state.write((ctx) => {
      patchPersona(ctx, personaId('implementer'), { modelPin: pin });
    });
    run();
    expect(modelsOf(null, 'implement')).toEqual(all(pinned));
    expect(RIGORS.map((r) => cell(null, r, 'implement').effort)).toEqual(RIGORS.map(() => 'low'));
  });

  it('lets the pin of the persona that fills the role beat a project’s role setting', () => {
    const bound = project('bound');
    const plain = project('plain');
    const pinnedPersona = addPersona('pinned-implementer', 'implement', {
      model: 'other-model',
      effort: 'high',
    });
    state.write((ctx) => {
      patchPersona(ctx, personaId('implementer'), { modelPin: pin });
      setTeam(ctx, bound.id, {
        bindings: [{ role: 'implement', personaId: pinnedPersona.id }],
        members: [],
      });
    });
    setting('implement', bound, capable);
    setting('implement', plain, capable);
    run();
    // The bound project's persona has its own pin; the plain one fills the role with the default persona.
    expect(modelsOf(bound, 'implement')).toEqual(all({ kind: 'model', model: 'other-model' }));
    expect(modelsOf(plain, 'implement')).toEqual(all(null));
    expect(modelsOf(null, 'implement')).toEqual(all(pinned));
  });

  it('never leaks the default persona’s pin into a project that binds a persona with none', () => {
    const own = project('own');
    const inherits = project('inherits');
    const unpinned = addPersona('plain-implementer', 'implement');
    state.write((ctx) => {
      patchPersona(ctx, personaId('implementer'), { modelPin: pin });
      for (const p of [own, inherits])
        setTeam(ctx, p.id, {
          bindings: [{ role: 'implement', personaId: unpinned.id }],
          members: [],
        });
    });
    setting('implement', null, capable);
    setting('implement', own, balanced);
    run();
    expect(modelsOf(own, 'implement')).toEqual(all(balanced));
    expect(modelsOf(inherits, 'implement')).toEqual(all(capable));
    // The effort is the role's own, not the pin's.
    expect(RIGORS.map((r) => cell(own, r, 'implement').effort)).toEqual(RIGORS.map(() => 'high'));
    expect(RIGORS.map((r) => cell(inherits, r, 'implement').effort)).toEqual(
      RIGORS.map(() => 'high'),
    );
  });

  it('raises an automatic cell to the persona’s minimum when that is higher than the cell’s', () => {
    state.write((ctx) => {
      patchPersona(ctx, personaId('implementer'), { minimumScore: 50 });
    });
    run();
    // Light 35, Standard 40 and Careful 45 rise to 50; Critical already asks 50.
    expect(modelsOf(null, 'implement')).toEqual([
      { kind: 'automatic', minimum: 50 },
      { kind: 'automatic', minimum: 50 },
      { kind: 'automatic', minimum: 50 },
      null,
    ]);
  });

  it('keeps a higher minimum of the role setting and reports a minimum a tier cannot carry', () => {
    state.write((ctx) => {
      patchPersona(ctx, personaId('implementer'), { minimumScore: 50 });
      patchPersona(ctx, personaId('reviewer'), { minimumScore: 50 });
    });
    setting('implement', null, { kind: 'automatic', minimum: 60 });
    setting('review', null, capable);
    const report = run();
    expect(modelsOf(null, 'implement')).toEqual(all({ kind: 'automatic', minimum: 60 }));
    expect(modelsOf(null, 'review')).toEqual(all(capable));
    expect(report.global.map((e) => e.setting)).toEqual(['Minimum score of the reviewer persona']);
  });
});

describe('moveToPlaybook: a flow step’s persona', () => {
  it('becomes the global cell’s persona at the flow’s rigor, and the second of two is reported', () => {
    const first = addPersona('deep-planner', 'plan');
    addPersona('other-planner', 'plan');
    addFlow('alpha', [
      { role: 'plan', need: 40, persona: 'deep-planner' },
      { role: 'implement', need: 40 },
    ]);
    addFlow('beta', [
      { role: 'plan', need: 40, persona: 'other-planner' },
      { role: 'implement', need: 40 },
    ]);
    const report = run();
    expect(cell(null, 'careful', 'plan').personaId).toBe(first.id);
    expect(cell(null, 'light', 'plan').personaId).toBeNull();
    expect(report.global).toEqual([
      expect.objectContaining({ setting: 'Persona of the plan step in the flow beta' }),
    ]);
  });
});

describe('moveToPlaybook: patterns', () => {
  const overridesOf = (key: string) => listKinds(state.db).find((k) => k.key === key)?.overrides;

  it('turns a global pattern on risk tags into an override on each kind, for its roles', () => {
    patterns(null, [pattern('Deps', { riskTags: ['dependency'], roles: ['review'] }, frontier)]);
    run();
    expect(overridesOf('dependency')).toEqual({
      review: { personaId: null, model: frontier, effort: null },
    });
  });

  it('applies to every role when the pattern names none, and raises a seeded override only if stronger', () => {
    patterns(null, [pattern('Security', { riskTags: ['security'] }, { kind: 'top_of_tier' })]);
    const report = run();
    const overrides = overridesOf('security');
    // Review was Frontier: the best of any tier is stronger. Plan and Implement rise; the other roles gain one.
    expect(overrides?.review?.model).toEqual({ kind: 'top_of_tier' });
    expect(overrides?.plan?.model).toEqual({ kind: 'top_of_tier' });
    expect(overrides?.implement?.model).toEqual({ kind: 'top_of_tier' });
    expect(overrides?.plan_review?.model).toEqual({ kind: 'top_of_tier' });
    expect(overrides?.qa?.model).toEqual({ kind: 'top_of_tier' });
    // The seeded effort stays with the override.
    expect(overrides?.review?.effort).toBe('high');
    expect(report.global).toEqual([]);
  });

  it('reports a pattern that would lower a model and leaves the override alone', () => {
    const before = overridesOf('security');
    patterns(null, [pattern('Cheap', { riskTags: ['security'], roles: ['review'] }, balanced)]);
    const report = run();
    expect(overridesOf('security')).toEqual(before);
    expect(report.global).toEqual([expect.objectContaining({ setting: 'Pattern "Cheap"' })]);
  });

  it('lets the pattern first by position win a kind and role', () => {
    patterns(null, [
      pattern('First', { riskTags: ['dependency'], roles: ['review'] }, capable),
      pattern('Second', { riskTags: ['dependency'], roles: ['review'] }, frontier),
    ]);
    run();
    expect(overridesOf('dependency')?.review?.model).toEqual(capable);
  });

  it('drops the seeded high-risk pattern, found by its content, and nothing else with it', () => {
    const before = listKinds(state.db);
    const report = run();
    expect(listKinds(state.db)).toEqual(before);
    expect(report.global).toEqual([]);
  });

  const unplaceable: { name: string; match: Partial<NewPattern['match']> }[] = [
    { name: 'an area pattern', match: { riskTags: ['auth'], areas: ['api'] } },
    { name: 'a retry pattern', match: { riskTags: ['auth'], retryOnly: true } },
    { name: 'a pattern on no risk tag', match: { roles: ['review'] } },
  ];
  it.each(unplaceable)('reports $name and moves nothing', ({ match }) => {
    const before = listKinds(state.db);
    patterns(null, [pattern('Mine', match, frontier)]);
    const report = run();
    expect(listKinds(state.db)).toEqual(before);
    expect(report.global).toEqual([expect.objectContaining({ setting: 'Pattern "Mine"' })]);
  });

  it('reports a project’s pattern on that project only', () => {
    const p = project('demo');
    const other = project('other');
    patterns(p, [pattern('Mine', { riskTags: ['auth'] }, frontier)]);
    const report = run();
    expect(report.global).toEqual([]);
    expect(report.projects.map((r) => r.projectId)).toEqual([p.id]);
    expect(other.id).not.toBe(p.id);
  });
});

describe('moveToPlaybook: what it leaves for the builder to read', () => {
  it('puts a project’s entries on one Inbox card, and the global ones in an app setting', () => {
    const p = project('demo');
    project('quiet');
    patterns(p, [pattern('Mine', { riskTags: ['auth'] }, frontier)]);
    patterns(null, [pattern('Areas', { riskTags: ['auth'], areas: ['api'] }, frontier)]);
    run();
    const cards = listInbox(state.db).filter((c) => c.kind === 'playbook_move_report');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ projectId: p.id, options: [], state: 'OPEN' });
    expect(cards[0]?.title).toContain('demo');
    expect(cards[0]?.body).toContain('Pattern "Mine"');
    const stored = PlaybookMoveEntry.array().parse(getAppSetting(state.db, 'playbook.moveReport'));
    expect(stored.map((e) => e.setting)).toEqual(['Pattern "Areas"']);
    expect(stored[0]?.value).toBeTruthy();
  });
});

describe('moveToPlaybook: once', () => {
  it('moves nothing the second time, whatever has changed since', () => {
    setting('review', null, capable);
    const p = project('demo');
    const task = newTask(p, { flow: 'quick', riskTags: ['security'] });
    run();
    const after = {
      global: getPlaybook(state.db, null),
      rigor: getTask(state.db, task.id).rigor,
    };
    setting('plan', null, frontier);
    newTask(p, { flow: 'full', riskTags: ['auth'], title: 'Another' });
    patterns(p, [pattern('Late', { riskTags: ['auth'] }, frontier)]);
    const again = run();
    expect(again).toEqual({ global: [], projects: [] });
    expect(getPlaybook(state.db, null)).toEqual(after.global);
    expect(getTask(state.db, task.id).rigor).toBe(after.rigor);
    expect(listInbox(state.db).filter((c) => c.kind === 'playbook_move_report')).toEqual([]);
    expect(getAppSetting(state.db, 'playbook.moved')).toBe(true);
  });

  it('writes the rows once on a start that finds nothing of the builder’s', () => {
    run();
    expect(getPlaybook(state.db, null)).toEqual({ rows: [], cells: [] });
    expect(getAppSetting(state.db, 'playbook.moveReport')).toEqual([]);
  });
});
