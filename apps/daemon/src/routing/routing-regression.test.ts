import {
  effectiveRigor,
  Rigor,
  StepRole,
  type ModelProfileDto,
  type PersonaDto,
  type KindDto,
} from '@10db/contracts';
import { createTestStore, listKinds, listModelProfiles, listPersonas } from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureForTests } from '../../test/catalogue';
import { buildMovedWorld, MOVED_SCENARIOS } from '../../test/moved-world';
import { seedProfiles } from '../../test/seed-profiles';
import { createEventBus, createStateStore } from '../events';
import { moveToPlaybook, resolveStepPlan, seedTeam } from '../team';
import { offeredProfiles } from './offered';
import { planSteps } from './plan-steps';

/**
 * What a task got before rigor and kinds, against what it gets now, on the seeded Claude catalogue with the
 * seeded kinds and no playbook overrides. Every difference carries the line of the design that explains it;
 * a difference with no line is a regression. Today's step lists and picks are written out here, not read from
 * code, so the table cannot drift with the code it checks.
 */

/** The lines of the design's Brief that change what a task runs. */
const BRIEF = {
  LIGHT_BUILD: 'A quick-flow task is Light: its build needs at least 35 (40 before)',
  STANDARD_REVIEW: 'A Standard review needs at least 40 (48 before)',
  FULL_IS_CAREFUL:
    'A full-flow task is Careful: it always plans, and QA and Plan Review stop running',
  KIND_RAISES_RIGOR:
    'A task of a security, auth or migration kind is at least Careful (it gains a Plan and a Review); dependency is at least Standard (it gains a Review)',
  FRONTIER_REVIEW:
    'Security and auth reviews, and migration reviews and plan reviews, run on Frontier at high effort; a migration still gets a Plan Review',
  MIGRATION_BUILD:
    'A migration build moves from the top model at low effort to the top of Capable at high effort',
  KIND_PLAN_OVERRIDE: 'A security, auth or migration Plan runs on Capable at high effort',
  KIND_BUILD_OVERRIDE: 'A security or auth build runs on the top of Capable at high effort',
  CAREFUL_UNSCORED: 'Without scores every Careful step runs one effort up',
  TASK_MODEL_BEATS_PIN: 'A task’s own model setting beats a cell that names one model',
  STRONGEST_WHEN_UNREACHED:
    'A step whose need no model reaches runs the strongest offered, and says so',
  ONE_MODEL_HELD:
    'A cell naming one model is never stepped up on a retry; only a persona pin held a step before',
} as const;

const LINES = BRIEF;
type Line = keyof typeof LINES;

type Mode = 'scored' | 'unmeasured';
type Change = readonly [role: StepRole, before: string | null, after: string | null, line: Line];
interface Case {
  readonly mode: Mode;
  readonly flow: 'quick' | 'standard' | 'full';
  /** Acceptance criteria: the old full flow planned and ran QA only above three. */
  readonly criteria: number;
  readonly tag: string;
  /** The rigor the task runs at now. */
  readonly rigor: Rigor;
  readonly changes: readonly Change[];
}

/** What the old role settings and the seeded high-risk pattern gave each role, by risk tag. */
const TODAY: Readonly<Record<Mode, Readonly<Record<string, Readonly<Record<StepRole, string>>>>>> =
  (() => {
    const scored = {
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
      migration: {
        plan: 'fable@low',
        plan_review: 'fable@low',
        implement: 'fable@low',
        review: 'fable@low',
        qa: 'sonnet@low',
      },
    } as const;
    const unmeasured = {
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
      migration: {
        plan: 'fable@high',
        plan_review: 'fable@high',
        implement: 'fable@xhigh',
        review: 'fable@high',
        qa: 'haiku@medium',
      },
    } as const;
    const by = (set: typeof scored | typeof unmeasured) => ({
      none: set.none,
      dependency: set.none,
      security: set.security,
      auth: set.security,
      migration: set.migration,
    });
    return { scored: by(scored), unmeasured: by(unmeasured) };
  })();

const RISKY = ['security', 'auth', 'migration'];

/** The steps each old flow ran: the full flow planned and ran QA above three criteria, and reviewed risk at plan review. */
function todaySteps(flow: Case['flow'], tag: string, criteria: number): StepRole[] {
  if (flow === 'quick') return [StepRole.Implement];
  if (flow === 'standard') return [StepRole.Implement, StepRole.Review];
  const long = criteria > 3;
  return [
    ...(long ? [StepRole.Plan] : []),
    ...(long && RISKY.includes(tag) ? [StepRole.PlanReview] : []),
    StepRole.Implement,
    StepRole.Review,
    ...(long ? [StepRole.Qa] : []),
  ];
}

/** The rigor each old flow becomes. */
const RIGOR_OF_FLOW: Readonly<Record<Case['flow'], Rigor>> = {
  quick: Rigor.Light,
  standard: Rigor.Standard,
  full: Rigor.Careful,
};

const CASES: readonly Case[] = [
  {
    mode: 'scored',
    flow: 'quick',
    criteria: 1,
    tag: 'none',
    rigor: 'light',
    changes: [['implement', 'sonnet@high', 'sonnet@low', 'LIGHT_BUILD']],
  },
  {
    mode: 'scored',
    flow: 'quick',
    criteria: 1,
    tag: 'security',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'KIND_RAISES_RIGOR'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', null, 'fable@high', 'KIND_RAISES_RIGOR'],
    ],
  },
  {
    mode: 'scored',
    flow: 'quick',
    criteria: 1,
    tag: 'auth',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'KIND_RAISES_RIGOR'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', null, 'fable@high', 'KIND_RAISES_RIGOR'],
    ],
  },
  {
    mode: 'scored',
    flow: 'quick',
    criteria: 1,
    tag: 'migration',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'KIND_RAISES_RIGOR'],
      ['plan_review', null, 'fable@high', 'FRONTIER_REVIEW'],
      ['implement', 'fable@low', 'opus@high', 'MIGRATION_BUILD'],
      ['review', null, 'fable@high', 'KIND_RAISES_RIGOR'],
    ],
  },
  {
    mode: 'scored',
    flow: 'quick',
    criteria: 1,
    tag: 'dependency',
    rigor: 'standard',
    changes: [['review', null, 'sonnet@high', 'KIND_RAISES_RIGOR']],
  },
  {
    mode: 'scored',
    flow: 'standard',
    criteria: 1,
    tag: 'none',
    rigor: 'standard',
    changes: [['review', 'opus@medium', 'sonnet@high', 'STANDARD_REVIEW']],
  },
  {
    mode: 'scored',
    flow: 'standard',
    criteria: 1,
    tag: 'security',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'KIND_RAISES_RIGOR'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@medium', 'fable@high', 'FRONTIER_REVIEW'],
    ],
  },
  {
    mode: 'scored',
    flow: 'standard',
    criteria: 1,
    tag: 'auth',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'KIND_RAISES_RIGOR'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@medium', 'fable@high', 'FRONTIER_REVIEW'],
    ],
  },
  {
    mode: 'scored',
    flow: 'standard',
    criteria: 1,
    tag: 'migration',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'KIND_RAISES_RIGOR'],
      ['plan_review', null, 'fable@high', 'FRONTIER_REVIEW'],
      ['implement', 'fable@low', 'opus@high', 'MIGRATION_BUILD'],
      ['review', 'fable@low', 'fable@high', 'FRONTIER_REVIEW'],
    ],
  },
  {
    mode: 'scored',
    flow: 'standard',
    criteria: 1,
    tag: 'dependency',
    rigor: 'standard',
    changes: [['review', 'opus@medium', 'sonnet@high', 'STANDARD_REVIEW']],
  },
  {
    mode: 'scored',
    flow: 'full',
    criteria: 4,
    tag: 'none',
    rigor: 'careful',
    changes: [
      ['implement', 'sonnet@high', 'opus@low', 'FULL_IS_CAREFUL'],
      ['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL'],
    ],
  },
  {
    mode: 'scored',
    flow: 'full',
    criteria: 4,
    tag: 'security',
    rigor: 'careful',
    changes: [
      ['plan', 'fable@low', 'opus@high', 'KIND_PLAN_OVERRIDE'],
      ['plan_review', 'fable@medium', null, 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@medium', 'fable@high', 'FRONTIER_REVIEW'],
      ['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL'],
    ],
  },
  {
    mode: 'scored',
    flow: 'full',
    criteria: 4,
    tag: 'auth',
    rigor: 'careful',
    changes: [
      ['plan', 'fable@low', 'opus@high', 'KIND_PLAN_OVERRIDE'],
      ['plan_review', 'fable@medium', null, 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@medium', 'fable@high', 'FRONTIER_REVIEW'],
      ['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL'],
    ],
  },
  {
    mode: 'scored',
    flow: 'full',
    criteria: 4,
    tag: 'migration',
    rigor: 'careful',
    changes: [
      ['plan', 'fable@low', 'opus@high', 'KIND_PLAN_OVERRIDE'],
      ['plan_review', 'fable@low', 'fable@high', 'FRONTIER_REVIEW'],
      ['implement', 'fable@low', 'opus@high', 'MIGRATION_BUILD'],
      ['review', 'fable@low', 'fable@high', 'FRONTIER_REVIEW'],
      ['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL'],
    ],
  },
  {
    mode: 'scored',
    flow: 'full',
    criteria: 4,
    tag: 'dependency',
    rigor: 'careful',
    changes: [
      ['implement', 'sonnet@high', 'opus@low', 'FULL_IS_CAREFUL'],
      ['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL'],
    ],
  },
  {
    mode: 'scored',
    flow: 'full',
    criteria: 1,
    tag: 'none',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@low', 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@low', 'FULL_IS_CAREFUL'],
    ],
  },
  {
    mode: 'scored',
    flow: 'full',
    criteria: 1,
    tag: 'security',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@medium', 'fable@high', 'FRONTIER_REVIEW'],
    ],
  },
  {
    mode: 'scored',
    flow: 'full',
    criteria: 1,
    tag: 'auth',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@medium', 'fable@high', 'FRONTIER_REVIEW'],
    ],
  },
  {
    mode: 'scored',
    flow: 'full',
    criteria: 1,
    tag: 'migration',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'FULL_IS_CAREFUL'],
      ['plan_review', null, 'fable@high', 'FRONTIER_REVIEW'],
      ['implement', 'fable@low', 'opus@high', 'MIGRATION_BUILD'],
      ['review', 'fable@low', 'fable@high', 'FRONTIER_REVIEW'],
    ],
  },
  {
    mode: 'scored',
    flow: 'full',
    criteria: 1,
    tag: 'dependency',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@low', 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@low', 'FULL_IS_CAREFUL'],
    ],
  },
  { mode: 'unmeasured', flow: 'quick', criteria: 1, tag: 'none', rigor: 'light', changes: [] },
  {
    mode: 'unmeasured',
    flow: 'quick',
    criteria: 1,
    tag: 'security',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@xhigh', 'KIND_RAISES_RIGOR'],
      ['implement', 'sonnet@high', 'opus@xhigh', 'KIND_BUILD_OVERRIDE'],
      ['review', null, 'fable@xhigh', 'KIND_RAISES_RIGOR'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'quick',
    criteria: 1,
    tag: 'auth',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@xhigh', 'KIND_RAISES_RIGOR'],
      ['implement', 'sonnet@high', 'opus@xhigh', 'KIND_BUILD_OVERRIDE'],
      ['review', null, 'fable@xhigh', 'KIND_RAISES_RIGOR'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'quick',
    criteria: 1,
    tag: 'migration',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@xhigh', 'KIND_RAISES_RIGOR'],
      ['plan_review', null, 'fable@xhigh', 'FRONTIER_REVIEW'],
      ['implement', 'fable@xhigh', 'opus@xhigh', 'MIGRATION_BUILD'],
      ['review', null, 'fable@xhigh', 'KIND_RAISES_RIGOR'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'quick',
    criteria: 1,
    tag: 'dependency',
    rigor: 'standard',
    changes: [['review', null, 'opus@high', 'KIND_RAISES_RIGOR']],
  },
  {
    mode: 'unmeasured',
    flow: 'standard',
    criteria: 1,
    tag: 'none',
    rigor: 'standard',
    changes: [],
  },
  {
    mode: 'unmeasured',
    flow: 'standard',
    criteria: 1,
    tag: 'security',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@xhigh', 'KIND_RAISES_RIGOR'],
      ['implement', 'sonnet@high', 'opus@xhigh', 'KIND_BUILD_OVERRIDE'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'standard',
    criteria: 1,
    tag: 'auth',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@xhigh', 'KIND_RAISES_RIGOR'],
      ['implement', 'sonnet@high', 'opus@xhigh', 'KIND_BUILD_OVERRIDE'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'standard',
    criteria: 1,
    tag: 'migration',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@xhigh', 'KIND_RAISES_RIGOR'],
      ['plan_review', null, 'fable@xhigh', 'FRONTIER_REVIEW'],
      ['implement', 'fable@xhigh', 'opus@xhigh', 'MIGRATION_BUILD'],
      ['review', 'fable@high', 'fable@xhigh', 'CAREFUL_UNSCORED'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'standard',
    criteria: 1,
    tag: 'dependency',
    rigor: 'standard',
    changes: [],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 4,
    tag: 'none',
    rigor: 'careful',
    changes: [
      ['plan', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['implement', 'sonnet@high', 'sonnet@xhigh', 'CAREFUL_UNSCORED'],
      ['review', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 4,
    tag: 'security',
    rigor: 'careful',
    changes: [
      ['plan', 'fable@high', 'opus@xhigh', 'KIND_PLAN_OVERRIDE'],
      ['plan_review', 'fable@xhigh', null, 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@xhigh', 'KIND_BUILD_OVERRIDE'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 4,
    tag: 'auth',
    rigor: 'careful',
    changes: [
      ['plan', 'fable@high', 'opus@xhigh', 'KIND_PLAN_OVERRIDE'],
      ['plan_review', 'fable@xhigh', null, 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@xhigh', 'KIND_BUILD_OVERRIDE'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 4,
    tag: 'migration',
    rigor: 'careful',
    changes: [
      ['plan', 'fable@high', 'opus@xhigh', 'KIND_PLAN_OVERRIDE'],
      ['plan_review', 'fable@high', 'fable@xhigh', 'CAREFUL_UNSCORED'],
      ['implement', 'fable@xhigh', 'opus@xhigh', 'MIGRATION_BUILD'],
      ['review', 'fable@high', 'fable@xhigh', 'CAREFUL_UNSCORED'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 4,
    tag: 'dependency',
    rigor: 'careful',
    changes: [
      ['plan', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['implement', 'sonnet@high', 'sonnet@xhigh', 'CAREFUL_UNSCORED'],
      ['review', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 1,
    tag: 'none',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@xhigh', 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'sonnet@xhigh', 'CAREFUL_UNSCORED'],
      ['review', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 1,
    tag: 'security',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@xhigh', 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@xhigh', 'KIND_BUILD_OVERRIDE'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 1,
    tag: 'auth',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@xhigh', 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@xhigh', 'KIND_BUILD_OVERRIDE'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 1,
    tag: 'migration',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@xhigh', 'FULL_IS_CAREFUL'],
      ['plan_review', null, 'fable@xhigh', 'FRONTIER_REVIEW'],
      ['implement', 'fable@xhigh', 'opus@xhigh', 'MIGRATION_BUILD'],
      ['review', 'fable@high', 'fable@xhigh', 'CAREFUL_UNSCORED'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 1,
    tag: 'dependency',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@xhigh', 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'sonnet@xhigh', 'CAREFUL_UNSCORED'],
      ['review', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
    ],
  },
];

const CANONICAL: Readonly<Record<string, string>> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};
const short = (model: string): string =>
  Object.entries(CANONICAL).find(([, id]) => id === model)?.[0] ?? model;

let profilesOf: Record<Mode, ModelProfileDto[]>;
let personas: PersonaDto[];
let kinds: KindDto[];
let close: () => void;
beforeAll(() => {
  const test = createTestStore();
  close = test.close;
  const state = createStateStore(test.store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  seedProfiles(state);
  personas = listPersonas(state.db).filter((p) => !p.archived);
  kinds = listKinds(state.db);
  const unmeasured = offeredProfiles(listModelProfiles(state.db), [], 'claude');
  measureForTests(state);
  profilesOf = { unmeasured, scored: offeredProfiles(listModelProfiles(state.db), [], 'claude') };
});
afterAll(() => {
  close();
});

/** What the task runs now: each step's pick and whether a retry may step it up. */
function nowFor(c: Case) {
  const taskKinds = c.tag === 'none' ? [] : [{ key: c.tag, source: 'agent' as const }];
  const rigor = effectiveRigor({
    rigor: RIGOR_OF_FLOW[c.flow],
    projectDefault: Rigor.Standard,
    taskKinds,
    kinds,
  });
  const plan = planSteps({
    rigor,
    task: { modelSetting: null, effortPin: null },
    taskKinds,
    kinds,
    playbook: { project: null, global: { rows: [], cells: [] } },
    project: { budgetCeiling: null },
    personas,
    profiles: profilesOf[c.mode],
    tierOverrides: {},
  });
  return {
    rigor,
    picks: new Map(plan.steps.map((s) => [s.role, `${short(s.model)}@${s.effort}`])),
    pinned: plan.steps.filter((s) => s.pinned).map((s) => s.role),
  };
}

describe('what a task runs, before and after rigor and kinds', () => {
  it.each(
    CASES.map((c) => ({ ...c, name: `${c.mode} ${c.flow}(${String(c.criteria)}) ${c.tag}` })),
  )('$name', (c) => {
    const now = nowFor(c);
    const before = new Set(todaySteps(c.flow, c.tag, c.criteria));
    const today = TODAY[c.mode][c.tag];
    const changes = Object.values(StepRole).flatMap((role) => {
      const was = before.has(role) ? (today?.[role] ?? null) : null;
      const is = now.picks.get(role) ?? null;
      return was === is ? [] : [[role, was, is]];
    });
    expect(now.rigor).toBe(c.rigor);
    expect(changes).toEqual(c.changes.map(([role, was, is]) => [role, was, is]));
    // Nothing seeded names one model, so a retry may step every step up, as before.
    expect(now.pinned).toEqual([]);
  });

  it('explains every difference by a line of the design', () => {
    const lines = new Set(CASES.flatMap((c) => c.changes.map(([, , , line]) => line)));
    for (const line of lines) expect(Object.keys(LINES)).toContain(line);
  });
});

/**
 * What the builder's own settings ran before, against what they run after the move, on the same catalogue:
 * role settings, a persona's pin and minimum, a team binding and a pattern, for a quick, a standard, a standard
 * dependency and a full task. A step's pick is `role=model@effort`, with `!` when a retry may not step it up.
 * Each row is the old step list, written out from the code before the playbook, and the changes that follow
 * from a line of the design; a row with none must come out the same.
 */
type MovedRow = readonly [
  mode: Mode,
  scenario: keyof typeof MOVED_SCENARIOS,
  task: string,
  today: readonly string[],
  changes: readonly (readonly [StepRole, string | null, string | null, ...Line[]])[],
];

const MOVED_ROWS: readonly MovedRow[] = [
  [
    'scored',
    'global review tier frontier',
    'quick',
    ['implement=sonnet@high'],
    [['implement', 'sonnet@high', 'sonnet@low', 'LIGHT_BUILD']],
  ],
  [
    'scored',
    'global review tier frontier',
    'standard',
    ['implement=sonnet@high', 'review=fable@low'],
    [],
  ],
  [
    'scored',
    'global review tier frontier',
    'standard+dependency',
    ['implement=sonnet@high', 'review=fable@low'],
    [],
  ],
  [
    'scored',
    'global review tier frontier',
    'full(4)',
    ['plan=opus@low', 'implement=sonnet@high', 'review=fable@low', 'qa=sonnet@low'],
    [
      ['implement', 'sonnet@high', 'opus@low', 'FULL_IS_CAREFUL'],
      ['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  [
    'scored',
    'global implement one model',
    'quick',
    ['implement=opus@low'],
    [['implement', 'opus@low', 'opus@low!', 'ONE_MODEL_HELD']],
  ],
  [
    'scored',
    'global implement one model',
    'standard',
    ['implement=opus@low', 'review=opus@medium'],
    [
      ['implement', 'opus@low', 'opus@low!', 'ONE_MODEL_HELD'],
      ['review', 'opus@medium', 'sonnet@high', 'STANDARD_REVIEW'],
    ],
  ],
  [
    'scored',
    'global implement one model',
    'standard+dependency',
    ['implement=opus@low', 'review=opus@medium'],
    [
      ['implement', 'opus@low', 'opus@low!', 'ONE_MODEL_HELD'],
      ['review', 'opus@medium', 'sonnet@high', 'STANDARD_REVIEW'],
    ],
  ],
  [
    'scored',
    'global implement one model',
    'full(4)',
    ['plan=opus@low', 'implement=opus@low', 'review=opus@medium', 'qa=sonnet@low'],
    [
      ['implement', 'opus@low', 'opus@low!', 'ONE_MODEL_HELD'],
      ['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  ['scored', 'pin beats the implement setting', 'quick', ['implement=opus@low!'], []],
  [
    'scored',
    'pin beats the implement setting',
    'standard',
    ['implement=opus@low!', 'review=opus@medium'],
    [['review', 'opus@medium', 'sonnet@high', 'STANDARD_REVIEW']],
  ],
  [
    'scored',
    'pin beats the implement setting',
    'standard+dependency',
    ['implement=opus@low!', 'review=opus@medium'],
    [['review', 'opus@medium', 'sonnet@high', 'STANDARD_REVIEW']],
  ],
  [
    'scored',
    'pin beats the implement setting',
    'full(4)',
    ['plan=opus@low', 'implement=opus@low!', 'review=opus@medium', 'qa=sonnet@low'],
    [['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL']],
  ],
  [
    'scored',
    'bound persona with a pin, global review capable',
    'quick',
    ['implement=sonnet@high'],
    [['implement', 'sonnet@high', 'sonnet@low', 'LIGHT_BUILD']],
  ],
  [
    'scored',
    'bound persona with a pin, global review capable',
    'standard',
    ['implement=sonnet@high', 'review=fable@medium!'],
    [],
  ],
  [
    'scored',
    'bound persona with a pin, global review capable',
    'standard+dependency',
    ['implement=sonnet@high', 'review=fable@medium!'],
    [],
  ],
  [
    'scored',
    'bound persona with a pin, global review capable',
    'full(4)',
    ['plan=opus@low', 'implement=sonnet@high', 'review=fable@medium!', 'qa=sonnet@low'],
    [
      ['implement', 'sonnet@high', 'opus@low', 'FULL_IS_CAREFUL'],
      ['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  [
    'scored',
    'project implement top of tier',
    'quick',
    ['implement=sonnet@high'],
    [['implement', 'sonnet@high', 'sonnet@low', 'LIGHT_BUILD']],
  ],
  [
    'scored',
    'project implement top of tier',
    'standard',
    ['implement=sonnet@high', 'review=opus@medium'],
    [['review', 'opus@medium', 'sonnet@high', 'STANDARD_REVIEW']],
  ],
  [
    'scored',
    'project implement top of tier',
    'standard+dependency',
    ['implement=sonnet@high', 'review=opus@medium'],
    [['review', 'opus@medium', 'sonnet@high', 'STANDARD_REVIEW']],
  ],
  [
    'scored',
    'project implement top of tier',
    'full(4)',
    ['plan=opus@low', 'implement=sonnet@high', 'review=opus@medium', 'qa=sonnet@low'],
    [
      ['implement', 'sonnet@high', 'fable@low', 'FULL_IS_CAREFUL'],
      ['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  [
    'scored',
    'project review one tier up, global review tier',
    'quick',
    ['implement=sonnet@high'],
    [['implement', 'sonnet@high', 'sonnet@low', 'LIGHT_BUILD']],
  ],
  [
    'scored',
    'project review one tier up, global review tier',
    'standard',
    ['implement=sonnet@high', 'review=opus@medium'],
    [['review', 'opus@medium', 'opus@low', 'STANDARD_REVIEW']],
  ],
  [
    'scored',
    'project review one tier up, global review tier',
    'standard+dependency',
    ['implement=sonnet@high', 'review=opus@medium'],
    [['review', 'opus@medium', 'opus@low', 'STANDARD_REVIEW']],
  ],
  [
    'scored',
    'project review one tier up, global review tier',
    'full(4)',
    ['plan=opus@low', 'implement=sonnet@high', 'review=opus@medium', 'qa=sonnet@low'],
    [
      ['implement', 'sonnet@high', 'opus@low', 'FULL_IS_CAREFUL'],
      ['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  [
    'scored',
    'global pattern: dependency review on frontier',
    'quick',
    ['implement=sonnet@high'],
    [['implement', 'sonnet@high', 'sonnet@low', 'LIGHT_BUILD']],
  ],
  [
    'scored',
    'global pattern: dependency review on frontier',
    'standard',
    ['implement=sonnet@high', 'review=opus@medium'],
    [['review', 'opus@medium', 'sonnet@high', 'STANDARD_REVIEW']],
  ],
  [
    'scored',
    'global pattern: dependency review on frontier',
    'standard+dependency',
    ['implement=sonnet@high', 'review=fable@low'],
    [],
  ],
  [
    'scored',
    'global pattern: dependency review on frontier',
    'full(4)',
    ['plan=opus@low', 'implement=sonnet@high', 'review=opus@medium', 'qa=sonnet@low'],
    [
      ['implement', 'sonnet@high', 'opus@low', 'FULL_IS_CAREFUL'],
      ['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  ['scored', 'implementer minimum 60', 'quick', ['implement=fable@max'], []],
  [
    'scored',
    'implementer minimum 60',
    'standard',
    ['implement=fable@max', 'review=opus@medium'],
    [['review', 'opus@medium', 'sonnet@high', 'STANDARD_REVIEW']],
  ],
  [
    'scored',
    'implementer minimum 60',
    'standard+dependency',
    ['implement=fable@max', 'review=opus@medium'],
    [['review', 'opus@medium', 'sonnet@high', 'STANDARD_REVIEW']],
  ],
  [
    'scored',
    'implementer minimum 60',
    'full(4)',
    ['plan=opus@low', 'implement=fable@max', 'review=opus@medium', 'qa=sonnet@low'],
    [['qa', 'sonnet@low', null, 'FULL_IS_CAREFUL']],
  ],
  ['unmeasured', 'implementer minimum 60', 'quick', ['implement=fable@xhigh'], []],
  [
    'unmeasured',
    'implementer minimum 60',
    'standard',
    ['implement=fable@xhigh', 'review=opus@high'],
    [],
  ],
  [
    'unmeasured',
    'implementer minimum 60',
    'standard+dependency',
    ['implement=fable@xhigh', 'review=opus@high'],
    [],
  ],
  [
    'unmeasured',
    'implementer minimum 60',
    'full(4)',
    ['plan=opus@high', 'implement=fable@xhigh', 'review=opus@high', 'qa=haiku@medium'],
    [
      ['plan', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['review', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  ['unmeasured', 'global review tier frontier', 'quick', ['implement=sonnet@high'], []],
  [
    'unmeasured',
    'global review tier frontier',
    'standard',
    ['implement=sonnet@high', 'review=fable@high'],
    [],
  ],
  [
    'unmeasured',
    'global review tier frontier',
    'standard+dependency',
    ['implement=sonnet@high', 'review=fable@high'],
    [],
  ],
  [
    'unmeasured',
    'global review tier frontier',
    'full(4)',
    ['plan=opus@high', 'implement=sonnet@high', 'review=fable@high', 'qa=haiku@medium'],
    [
      ['plan', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['implement', 'sonnet@high', 'sonnet@xhigh', 'CAREFUL_UNSCORED'],
      ['review', 'fable@high', 'fable@xhigh', 'CAREFUL_UNSCORED'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  [
    'unmeasured',
    'global implement one model',
    'quick',
    ['implement=opus@high'],
    [['implement', 'opus@high', 'opus@high!', 'ONE_MODEL_HELD']],
  ],
  [
    'unmeasured',
    'global implement one model',
    'standard',
    ['implement=opus@high', 'review=opus@high'],
    [['implement', 'opus@high', 'opus@high!', 'ONE_MODEL_HELD']],
  ],
  [
    'unmeasured',
    'global implement one model',
    'standard+dependency',
    ['implement=opus@high', 'review=opus@high'],
    [['implement', 'opus@high', 'opus@high!', 'ONE_MODEL_HELD']],
  ],
  [
    'unmeasured',
    'global implement one model',
    'full(4)',
    ['plan=opus@high', 'implement=opus@high', 'review=opus@high', 'qa=haiku@medium'],
    [
      ['plan', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['implement', 'opus@high', 'opus@xhigh!', 'ONE_MODEL_HELD', 'CAREFUL_UNSCORED'],
      ['review', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  ['unmeasured', 'pin beats the implement setting', 'quick', ['implement=opus@low!'], []],
  [
    'unmeasured',
    'pin beats the implement setting',
    'standard',
    ['implement=opus@low!', 'review=opus@high'],
    [],
  ],
  [
    'unmeasured',
    'pin beats the implement setting',
    'standard+dependency',
    ['implement=opus@low!', 'review=opus@high'],
    [],
  ],
  [
    'unmeasured',
    'pin beats the implement setting',
    'full(4)',
    ['plan=opus@high', 'implement=opus@low!', 'review=opus@high', 'qa=haiku@medium'],
    [
      ['plan', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['review', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  [
    'unmeasured',
    'bound persona with a pin, global review capable',
    'quick',
    ['implement=sonnet@high'],
    [],
  ],
  [
    'unmeasured',
    'bound persona with a pin, global review capable',
    'standard',
    ['implement=sonnet@high', 'review=fable@medium!'],
    [],
  ],
  [
    'unmeasured',
    'bound persona with a pin, global review capable',
    'standard+dependency',
    ['implement=sonnet@high', 'review=fable@medium!'],
    [],
  ],
  [
    'unmeasured',
    'bound persona with a pin, global review capable',
    'full(4)',
    ['plan=opus@high', 'implement=sonnet@high', 'review=fable@medium!', 'qa=haiku@medium'],
    [
      ['plan', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['implement', 'sonnet@high', 'sonnet@xhigh', 'CAREFUL_UNSCORED'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  ['unmeasured', 'project implement top of tier', 'quick', ['implement=sonnet@high'], []],
  [
    'unmeasured',
    'project implement top of tier',
    'standard',
    ['implement=sonnet@high', 'review=opus@high'],
    [],
  ],
  [
    'unmeasured',
    'project implement top of tier',
    'standard+dependency',
    ['implement=sonnet@high', 'review=opus@high'],
    [],
  ],
  [
    'unmeasured',
    'project implement top of tier',
    'full(4)',
    ['plan=opus@high', 'implement=sonnet@high', 'review=opus@high', 'qa=haiku@medium'],
    [
      ['plan', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['implement', 'sonnet@high', 'sonnet@xhigh', 'CAREFUL_UNSCORED'],
      ['review', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  [
    'unmeasured',
    'project review one tier up, global review tier',
    'quick',
    ['implement=sonnet@high'],
    [],
  ],
  [
    'unmeasured',
    'project review one tier up, global review tier',
    'standard',
    ['implement=sonnet@high', 'review=opus@high'],
    [],
  ],
  [
    'unmeasured',
    'project review one tier up, global review tier',
    'standard+dependency',
    ['implement=sonnet@high', 'review=opus@high'],
    [],
  ],
  [
    'unmeasured',
    'project review one tier up, global review tier',
    'full(4)',
    ['plan=opus@high', 'implement=sonnet@high', 'review=opus@high', 'qa=haiku@medium'],
    [
      ['plan', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['implement', 'sonnet@high', 'sonnet@xhigh', 'CAREFUL_UNSCORED'],
      ['review', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  ],
  [
    'unmeasured',
    'global pattern: dependency review on frontier',
    'quick',
    ['implement=sonnet@high'],
    [],
  ],
  [
    'unmeasured',
    'global pattern: dependency review on frontier',
    'standard',
    ['implement=sonnet@high', 'review=opus@high'],
    [],
  ],
  [
    'unmeasured',
    'global pattern: dependency review on frontier',
    'standard+dependency',
    ['implement=sonnet@high', 'review=fable@high'],
    [],
  ],
  [
    'unmeasured',
    'global pattern: dependency review on frontier',
    'full(4)',
    ['plan=opus@high', 'implement=sonnet@high', 'review=opus@high', 'qa=haiku@medium'],
    [
      ['plan', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['implement', 'sonnet@high', 'sonnet@xhigh', 'CAREFUL_UNSCORED'],
      ['review', 'opus@high', 'opus@xhigh', 'CAREFUL_UNSCORED'],
      ['qa', 'haiku@medium', null, 'FULL_IS_CAREFUL'],
    ],
  ],
];

const MOVED_RIGOR: Readonly<Record<string, Rigor>> = {
  quick: Rigor.Light,
  standard: Rigor.Standard,
  'standard+dependency': Rigor.Standard,
  'full(4)': Rigor.Careful,
};

/** The step list after the row's changes, in role order. */
function afterChanges(row: MovedRow): string[] {
  const picks = new Map(
    row[3].map((step) => {
      const [role = '', pick = ''] = step.split('=');
      return [role, pick] as const;
    }),
  );
  for (const [role, before, after] of row[4]) {
    expect(picks.get(role) ?? null).toBe(before);
    if (after === null) picks.delete(role);
    else picks.set(role, after);
  }
  return Object.values(StepRole).flatMap((role) => {
    const pick = picks.get(role);
    return pick === undefined ? [] : [`${role}=${pick}`];
  });
}

const GROUPS = Map.groupBy(MOVED_ROWS, (row) => `${row[0]} | ${row[1]}`);

describe.each([...GROUPS])('what moved settings run: %s', (_name, rows) => {
  const [first] = rows;
  const taskNames = rows.map((row) => row[2]);
  let plans: Map<string, { rigor: Rigor | null; steps: string[] }>;
  let close: () => void;
  beforeAll(() => {
    const test = createTestStore();
    close = test.close;
    const state = createStateStore(test.store, createEventBus());
    seedTeam(state, readDefaultPersonas());
    seedProfiles(state);
    if (first?.[0] === 'scored') measureForTests(state);
    const setup = first ? MOVED_SCENARIOS[first[1]] : undefined;
    if (!setup) throw new Error('a row names no scenario');
    const world = buildMovedWorld(state, test.store, setup);
    state.write((ctx) => {
      moveToPlaybook(ctx);
    });
    plans = new Map(
      taskNames.flatMap((name) => {
        const id = world.taskIds.get(name);
        if (!id) return [];
        const plan = resolveStepPlan(state.db, id);
        return [
          [
            name,
            {
              rigor: plan.rigor,
              steps: plan.steps.map(
                (s) => `${s.role}=${short(s.model)}@${s.effort}${s.pinned ? '!' : ''}`,
              ),
            },
          ] as const,
        ];
      }),
    );
  });
  afterAll(() => {
    close();
  });
  it.each(rows.map((row) => ({ name: row[2], row })))('$name', ({ name, row }) => {
    expect(plans.get(name)).toEqual({ rigor: MOVED_RIGOR[name], steps: afterChanges(row) });
  });
});

describe('the moved settings table', () => {
  it('explains every difference by a line of the design', () => {
    const lines = new Set(MOVED_ROWS.flatMap((row) => row[4].flatMap((c) => c.slice(3))));
    for (const line of lines) expect(Object.keys(LINES)).toContain(line);
  });
});
