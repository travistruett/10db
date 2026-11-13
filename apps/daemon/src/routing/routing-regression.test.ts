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
import { seedProfiles } from '../../test/seed-profiles';
import { createEventBus, createStateStore } from '../events';
import { seedTeam } from '../team';
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
  CAREFUL_UNSCORED: 'Without scores every Careful step runs one effort up',
} as const;

/**
 * Differences that follow the agreed overrides for security, auth and migration kinds (design §6.1: Plan on
 * Capable at high effort, Build on the top of Capable at high effort) but that the Brief's list does not
 * itemize: the seeded high-risk pattern gave these steps the dearest model of their own rung. Kept apart so
 * the Brief can be amended or the overrides changed.
 */
const NOT_ITEMIZED = {
  KIND_PLAN_OVERRIDE: 'A security, auth or migration Plan runs on Capable at high effort',
  KIND_BUILD_OVERRIDE: 'A security or auth build runs on the top of Capable at high effort',
} as const;

const LINES = { ...BRIEF, ...NOT_ITEMIZED };
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
      ['plan', null, 'opus@high', 'KIND_RAISES_RIGOR'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', null, 'fable@high', 'KIND_RAISES_RIGOR'],
    ],
  },
  {
    mode: 'unmeasured',
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
    mode: 'unmeasured',
    flow: 'quick',
    criteria: 1,
    tag: 'migration',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'KIND_RAISES_RIGOR'],
      ['plan_review', null, 'fable@high', 'FRONTIER_REVIEW'],
      ['implement', 'fable@xhigh', 'opus@high', 'MIGRATION_BUILD'],
      ['review', null, 'fable@high', 'KIND_RAISES_RIGOR'],
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
      ['plan', null, 'opus@high', 'KIND_RAISES_RIGOR'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@xhigh', 'fable@high', 'FRONTIER_REVIEW'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'standard',
    criteria: 1,
    tag: 'auth',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'KIND_RAISES_RIGOR'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@xhigh', 'fable@high', 'FRONTIER_REVIEW'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'standard',
    criteria: 1,
    tag: 'migration',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'KIND_RAISES_RIGOR'],
      ['plan_review', null, 'fable@high', 'FRONTIER_REVIEW'],
      ['implement', 'fable@xhigh', 'opus@high', 'MIGRATION_BUILD'],
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
      ['plan', 'fable@high', 'opus@high', 'KIND_PLAN_OVERRIDE'],
      ['plan_review', 'fable@xhigh', null, 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@xhigh', 'fable@high', 'FRONTIER_REVIEW'],
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
      ['plan', 'fable@high', 'opus@high', 'KIND_PLAN_OVERRIDE'],
      ['plan_review', 'fable@xhigh', null, 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@xhigh', 'fable@high', 'FRONTIER_REVIEW'],
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
      ['plan', 'fable@high', 'opus@high', 'KIND_PLAN_OVERRIDE'],
      ['implement', 'fable@xhigh', 'opus@high', 'MIGRATION_BUILD'],
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
      ['plan', null, 'opus@high', 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@xhigh', 'fable@high', 'FRONTIER_REVIEW'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 1,
    tag: 'auth',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'FULL_IS_CAREFUL'],
      ['implement', 'sonnet@high', 'opus@high', 'KIND_BUILD_OVERRIDE'],
      ['review', 'fable@xhigh', 'fable@high', 'FRONTIER_REVIEW'],
    ],
  },
  {
    mode: 'unmeasured',
    flow: 'full',
    criteria: 1,
    tag: 'migration',
    rigor: 'careful',
    changes: [
      ['plan', null, 'opus@high', 'FULL_IS_CAREFUL'],
      ['plan_review', null, 'fable@high', 'FRONTIER_REVIEW'],
      ['implement', 'fable@xhigh', 'opus@high', 'MIGRATION_BUILD'],
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

  it('keeps the differences the Brief does not itemize apart, so they are decided on purpose', () => {
    const used = new Set(CASES.flatMap((c) => c.changes.map(([, , , line]) => line)));
    expect([...used].filter((line) => line in NOT_ITEMIZED).sort()).toEqual([
      'KIND_BUILD_OVERRIDE',
      'KIND_PLAN_OVERRIDE',
    ]);
  });
});
