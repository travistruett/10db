import {
  mintId,
  type FlowDto,
  type ModelProfileDto,
  type PatternDto,
  type PersonaDto,
  type RiskTag,
  type RoleSettingDto,
  type StepRole,
} from '@10db/contracts';
import {
  createTestStore,
  listModelProfiles,
  listPatterns,
  listPersonas,
  listRoleSettings,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureForTests } from '../../test/catalogue';
import { seedProfiles } from '../../test/seed-profiles';
import { createEventBus, createStateStore } from '../events';
import { seedTeam } from '../team';
import { DEFAULT_FLOWS } from './catalogue';
import { offeredProfiles } from './offered';
import { planSteps } from './plan-steps';

const NOW = '2026-10-17T12:00:00.000Z';

/** Each role's model and effort under each risk tag, as `model@effort`, the model by its short name. */
type Routing = Readonly<Record<string, Readonly<Record<StepRole, string>>>>;

/** Seeded Claude profiles carrying the invented measurements of `test/catalogue.ts`: routed by score. */
const SCORED: Routing = {
  none: {
    plan: 'opus@low',
    plan_review: 'opus@medium',
    implement: 'sonnet@high',
    review: 'opus@medium',
    qa: 'sonnet@low',
  },
  security: {
    plan: 'fable@low',
    plan_review: 'fable@medium',
    implement: 'sonnet@high',
    review: 'fable@medium',
    qa: 'sonnet@low',
  },
  auth: {
    plan: 'fable@low',
    plan_review: 'fable@medium',
    implement: 'sonnet@high',
    review: 'fable@medium',
    qa: 'sonnet@low',
  },
  migration: {
    plan: 'fable@low',
    plan_review: 'fable@low',
    implement: 'fable@low',
    review: 'fable@low',
    qa: 'sonnet@low',
  },
};

/** The same profiles with nothing measured: the role-default path. */
const DEFAULTED: Routing = {
  none: {
    plan: 'opus@high',
    plan_review: 'opus@high',
    implement: 'sonnet@high',
    review: 'opus@high',
    qa: 'haiku@medium',
  },
  security: {
    plan: 'fable@high',
    plan_review: 'fable@xhigh',
    implement: 'sonnet@high',
    review: 'fable@xhigh',
    qa: 'haiku@medium',
  },
  auth: {
    plan: 'fable@high',
    plan_review: 'fable@xhigh',
    implement: 'sonnet@high',
    review: 'fable@xhigh',
    qa: 'haiku@medium',
  },
  migration: {
    plan: 'fable@high',
    plan_review: 'fable@high',
    implement: 'fable@xhigh',
    review: 'fable@high',
    qa: 'haiku@medium',
  },
};

/** The short names the tables use, and the canonical ID each stands for. */
const CANONICAL: Readonly<Record<string, string>> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};
const canonical = (want: string): string => {
  const [model = '', effort = ''] = want.split('@');
  return `${CANONICAL[model] ?? model}@${effort}`;
};

const TAGS: Readonly<Record<string, RiskTag[]>> = {
  none: [],
  security: ['security'],
  auth: ['auth'],
  migration: ['migration'],
};

let scored: ModelProfileDto[];
let unmeasured: ModelProfileDto[];
let personas: PersonaDto[];
let roleSettings: RoleSettingDto[];
let patterns: PatternDto[];
let close: () => void;
beforeAll(() => {
  const test = createTestStore();
  close = test.close;
  const state = createStateStore(test.store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  seedProfiles(state);
  personas = listPersonas(state.db).filter((p) => !p.archived);
  roleSettings = listRoleSettings(state.db);
  patterns = listPatterns(state.db);
  unmeasured = offeredProfiles(listModelProfiles(state.db), [], 'claude');
  measureForTests(state);
  scored = offeredProfiles(listModelProfiles(state.db), [], 'claude');
});
afterAll(() => {
  close();
});

/** The `full` flow at its default needs with every skip rule dropped, so each role is planned for any task. */
const everyStep: FlowDto = {
  id: mintId('Flow'),
  name: 'full',
  steps: (DEFAULT_FLOWS.find((f) => f.name === 'full')?.steps ?? []).map((s) => ({
    ...s,
    skip: [],
    persona: s.persona ?? null,
  })),
  createdAt: NOW,
  updatedAt: NOW,
};

const planned = (profiles: readonly ModelProfileDto[], riskTags: RiskTag[]) =>
  Object.fromEntries(
    planSteps({
      flow: everyStep,
      task: { riskTags, acceptanceCriteria: ['c'], areas: [], modelSetting: null },
      project: { id: mintId('Project'), budgetCeiling: null },
      personas,
      bindings: [],
      profiles,
      roleSettings,
      patterns,
      tierOverrides: {},
    }).steps.map((s) => [s.role, `${s.model}@${s.effort}`]),
  );

const rows = (want: Routing) =>
  Object.entries(want).flatMap(([tag, byRole]) =>
    Object.entries(byRole).map(([role, model]) => ({ tag, role, model })),
  );

// Pins what the shipped needs, floors and role defaults choose today, so moving routing off model
// aliases changes it only on purpose. The router and role-default tests prove the rules on invented
// catalogues; these rows prove the seeded Claude catalogue and the flow's real needs.
describe('routing of the default flow on the seeded Claude catalogue', () => {
  it.each(rows(SCORED))('scored: $role with risk $tag runs $model', ({ tag, role, model }) => {
    expect(planned(scored, TAGS[tag] ?? [])[role]).toBe(canonical(model));
  });

  it.each(rows(DEFAULTED))(
    'unmeasured: $role with risk $tag runs $model',
    ({ tag, role, model }) => {
      expect(planned(unmeasured, TAGS[tag] ?? [])[role]).toBe(canonical(model));
    },
  );
});
