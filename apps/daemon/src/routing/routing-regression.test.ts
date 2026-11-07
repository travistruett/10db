import {
  mintId,
  type FlowDto,
  type ModelProfileDto,
  type PersonaDto,
  type RiskTag,
  type StepRole,
} from '@10db/contracts';
import { createTestStore, listModelProfiles, listPersonas } from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureForTests } from '../../test/catalogue';
import { createEventBus, createStateStore } from '../events';
import { seedTeam } from '../team';
import { DEFAULT_FLOWS } from './catalogue';
import { planSteps } from './plan-steps';

const NOW = '2026-10-17T12:00:00.000Z';

/** Each role's model and effort under each risk tag, as `model@effort`. */
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
    plan: 'opus@low',
    plan_review: 'opus@xhigh',
    implement: 'sonnet@high',
    review: 'opus@xhigh',
    qa: 'sonnet@low',
  },
  auth: {
    plan: 'opus@low',
    plan_review: 'opus@xhigh',
    implement: 'sonnet@high',
    review: 'opus@xhigh',
    qa: 'sonnet@low',
  },
  migration: {
    plan: 'opus@low',
    plan_review: 'opus@medium',
    implement: 'opus@low',
    review: 'opus@medium',
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
    plan: 'opus@high',
    plan_review: 'opus@xhigh',
    implement: 'sonnet@high',
    review: 'opus@xhigh',
    qa: 'haiku@medium',
  },
  auth: {
    plan: 'opus@high',
    plan_review: 'opus@xhigh',
    implement: 'sonnet@high',
    review: 'opus@xhigh',
    qa: 'haiku@medium',
  },
  migration: {
    plan: 'opus@high',
    plan_review: 'opus@high',
    implement: 'opus@xhigh',
    review: 'opus@high',
    qa: 'haiku@medium',
  },
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
let close: () => void;
beforeAll(() => {
  const test = createTestStore();
  close = test.close;
  const state = createStateStore(test.store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  personas = listPersonas(state.db).filter((p) => !p.archived);
  unmeasured = listModelProfiles(state.db);
  measureForTests(state);
  scored = listModelProfiles(state.db);
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
      task: { riskTags, acceptanceCriteria: ['c'] },
      project: { provider: 'claude', budgetCeiling: null },
      personas,
      bindings: [],
      profiles,
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
    expect(planned(scored, TAGS[tag] ?? [])[role]).toBe(model);
  });

  it.each(rows(DEFAULTED))(
    'unmeasured: $role with risk $tag runs $model',
    ({ tag, role, model }) => {
      expect(planned(unmeasured, TAGS[tag] ?? [])[role]).toBe(model);
    },
  );
});
