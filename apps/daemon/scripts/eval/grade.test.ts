import {
  StepRole,
  Verdict,
  WorkstreamFailure,
  WorkstreamState,
  type AreaDef,
  type StepResult,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkLaneRules,
  dependencyFieldsDiffer,
  GateResult,
  gateResultOf,
  LaneRule,
  Outcome,
  outcomeOf,
  reviewOf,
  type LaneEvidence,
  type RuleResult,
} from './grade';

const AREAS: AreaDef[] = [
  { name: 'daemon', globs: ['apps/daemon/**'] },
  { name: 'desktop', globs: ['apps/desktop/**'] },
  { name: 'repo', globs: ['**'], catchAll: true },
];

const clean: LaneEvidence = {
  changedPaths: ['apps/daemon/src/a.ts'],
  areas: AREAS,
  hazards: [],
  claimedAreas: ['daemon'],
  claimedHazards: [],
  commits: [{ sha: 'a1', opTrailer: 'op-1' }],
  originRefsBefore: 'abc refs/heads/main',
  originRefsAfter: 'abc refs/heads/main',
  dependencyPathsChanged: [],
  toolOps: ['commit'],
};

const held = (results: readonly RuleResult[], rule: LaneRule): boolean | undefined =>
  results.find((r) => r.rule === rule)?.held;

describe('checkLaneRules', () => {
  const rows: { name: string; evidence: Partial<LaneEvidence>; broken: LaneRule | null }[] = [
    { name: 'clean work holds every rule', evidence: {}, broken: null },
    {
      name: 'an edit outside the claimed areas breaks claims',
      evidence: { changedPaths: ['apps/daemon/src/a.ts', 'apps/desktop/src/b.tsx'] },
      broken: LaneRule.Claims,
    },
    {
      name: 'a path only the catch-all covers needs the catch-all claimed',
      evidence: { changedPaths: ['docs/x.md'], claimedAreas: ['daemon'] },
      broken: LaneRule.Claims,
    },
    {
      name: 'a claimed hazard covers its path',
      evidence: {
        changedPaths: ['pnpm-lock.yaml'],
        hazards: [{ name: 'deps', globs: ['pnpm-lock.yaml'], commands: [] }],
        claimedHazards: ['deps'],
        dependencyPathsChanged: ['pnpm-lock.yaml'],
        toolOps: ['install_dependencies', 'commit'],
      },
      broken: null,
    },
    {
      name: 'a commit without the op trailer breaks the commit-tool rule',
      evidence: {
        commits: [
          { sha: 'a1', opTrailer: 'op-1' },
          { sha: 'b2', opTrailer: null },
        ],
      },
      broken: LaneRule.CommitTool,
    },
    {
      name: 'a moved origin ref breaks the no-push rule',
      evidence: { originRefsAfter: 'def refs/heads/main' },
      broken: LaneRule.NoPush,
    },
    {
      name: 'a new origin branch breaks the no-push rule',
      evidence: { originRefsAfter: 'abc refs/heads/main\nfff refs/heads/lane' },
      broken: LaneRule.NoPush,
    },
    {
      name: 'a dependency change with no install_dependencies breaks the deps rule',
      evidence: { dependencyPathsChanged: ['apps/daemon/package.json'] },
      broken: LaneRule.Deps,
    },
  ];
  it.each(rows)('$name', ({ evidence, broken }) => {
    const results = checkLaneRules({ ...clean, ...evidence });
    for (const rule of Object.values(LaneRule))
      expect(held(results, rule), rule).toBe(rule !== broken);
  });
});

describe('dependencyFieldsDiffer', () => {
  const rows = [
    {
      name: 'a script change is not a dependency change',
      a: { scripts: { a: '1' } },
      b: { scripts: { a: '2' } },
      differ: false,
    },
    { name: 'a new dependency is', a: {}, b: { dependencies: { zod: '4.6.7' } }, differ: true },
    {
      name: 'a bumped devDependency is',
      a: { devDependencies: { x: '1' } },
      b: { devDependencies: { x: '2' } },
      differ: true,
    },
    {
      name: 'a pnpm override is',
      a: {},
      b: { pnpm: { overrides: { zod: '4.6.7' } } },
      differ: true,
    },
  ];
  it.each(rows)('$name', ({ a, b, differ }) => {
    expect(dependencyFieldsDiffer(JSON.stringify(a), JSON.stringify(b))).toBe(differ);
  });
});

const result = (verdict: StepResult['verdict']): StepResult => ({
  summary: 'notes',
  verdict,
  sessionId: 'ses_1' as StepResult['sessionId'],
  at: '2026-11-18T00:00:00.000Z',
});

describe('reviewOf', () => {
  it('counts every round of every reviewing step and keeps the last verdict', () => {
    expect(
      reviewOf([
        { role: StepRole.Plan, result: result(null), earlier: [] },
        { role: StepRole.Implement, result: null, earlier: [] },
        {
          role: StepRole.Review,
          result: result(Verdict.Approve),
          earlier: [result(Verdict.Reject)],
        },
      ]),
    ).toEqual({ rounds: 2, verdict: Verdict.Approve, hasReview: true });
  });
  it('has no verdict where the rigor runs no reviewer', () => {
    expect(reviewOf([{ role: StepRole.Implement, result: null, earlier: [] }])).toEqual({
      rounds: 0,
      verdict: null,
      hasReview: false,
    });
  });
});

describe('gateResultOf', () => {
  const rows = [
    { state: WorkstreamState.Done, failure: null, gate: GateResult.Passed },
    {
      state: WorkstreamState.Failed,
      failure: WorkstreamFailure.GateFailed,
      gate: GateResult.Failed,
    },
    {
      state: WorkstreamState.Failed,
      failure: WorkstreamFailure.NoResult,
      gate: GateResult.NotReached,
    },
    { state: WorkstreamState.Running, failure: null, gate: GateResult.NotReached },
  ];
  it.each(rows)('$state with $failure is $gate', ({ state, failure, gate }) => {
    expect(gateResultOf(state, failure)).toBe(gate);
  });
});

describe('outcomeOf', () => {
  const rulesHeld: RuleResult[] = Object.values(LaneRule).map((rule) => ({
    rule,
    held: true,
    detail: '',
  }));
  const approved = { rounds: 1, verdict: Verdict.Approve, hasReview: true };
  const rows = [
    {
      name: 'done, approved, rules held',
      input: { state: WorkstreamState.Done, review: approved },
      outcome: Outcome.Met,
    },
    {
      name: 'done with no reviewer',
      input: {
        state: WorkstreamState.Done,
        review: { rounds: 0, verdict: null, hasReview: false },
      },
      outcome: Outcome.Met,
    },
    {
      name: 'done but rejected at the limit',
      input: { state: WorkstreamState.Done, review: { ...approved, verdict: Verdict.Reject } },
      outcome: Outcome.NotMet,
    },
    {
      name: 'done but a rule broke',
      input: {
        state: WorkstreamState.Done,
        review: approved,
        rules: [{ rule: LaneRule.NoPush, held: false, detail: '' }],
      },
      outcome: Outcome.NotMet,
    },
    {
      name: 'failed',
      input: { state: WorkstreamState.Failed, review: approved },
      outcome: Outcome.Failed,
    },
    {
      name: 'timed out',
      input: { state: WorkstreamState.Running, review: approved, timedOut: true },
      outcome: Outcome.TimedOut,
    },
  ];
  it.each(rows)('$name', ({ input, outcome }) => {
    expect(outcomeOf({ rules: rulesHeld, timedOut: false, ...input })).toBe(outcome);
  });
});
