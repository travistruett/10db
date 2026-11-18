import { Rigor, Verdict } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { GateResult, Outcome } from './grade';
import { EvalAgent, EvalReport, renderReport, type CaseRun } from './report';

const run = (n: number, outcome: Outcome, gate: GateResult): CaseRun => ({
  run: n,
  outcome,
  workstreamState: 'DONE',
  failureReason: null,
  gate,
  reviewVerdict: Verdict.Approve,
  reviewRounds: 1,
  sessions: 2,
  handoffs: 0,
  spawns: null,
  inputTokens: 10,
  outputTokens: 5,
  cachedTokens: 0,
  costUsd: null,
  wallSeconds: 3,
  rules: [],
  missingTranscripts: [],
});

const report = (plansInBuild: boolean | null, outcomes: readonly Outcome[]): EvalReport => ({
  rigor: Rigor.Careful,
  agent: EvalAgent.Fake,
  plansInBuild,
  startedAt: '2026-11-18T00:00:00.000Z',
  finishedAt: '2026-11-18T00:01:00.000Z',
  cases: [
    {
      id: 'a',
      title: 'A',
      runs: outcomes.map((o, i) => run(i + 1, o, GateResult.Passed)),
    },
  ],
});

describe('the keep rule in a report', () => {
  it.each([
    {
      name: 'holds when the change meets as often as the baseline',
      now: [Outcome.Met, Outcome.Met],
      want: '**Holds**: 2 met runs against the baseline’s 2, and no case lost.',
    },
    {
      name: 'fails and names the case the change lost',
      now: [Outcome.NotMet, Outcome.Failed],
      want: '**Fails**: 0 met runs against the baseline’s 2. Lost (met in the baseline, in neither run now): a.',
    },
  ])('$name', ({ now, want }) => {
    const markdown = renderReport(report(true, now), report(false, [Outcome.Met, Outcome.Met]));
    expect(markdown).toContain(
      '# Lane-pipeline eval: careful, fake agent, plans in the Build session',
    );
    expect(markdown).toContain(`## Keep rule\n\n${want}`);
  });

  it('says there is nothing to keep against with no baseline', () => {
    expect(renderReport(report(null, [Outcome.Met]), null)).toContain(
      '## Keep rule\n\nNo baseline report was given.',
    );
  });

  it('reads a report saved before it named the setting', () => {
    const saved: Record<string, unknown> = { ...report(null, [Outcome.Met]) };
    delete saved['plansInBuild'];
    expect(EvalReport.parse(saved).plansInBuild).toBeNull();
  });
});

describe('renderReport', () => {
  it('lists a case’s runs in order and counts them in the total', () => {
    const markdown = renderReport(
      {
        rigor: Rigor.Standard,
        agent: EvalAgent.Fake,
        plansInBuild: null,
        startedAt: '2026-11-18T00:00:00.000Z',
        finishedAt: '2026-11-18T00:01:00.000Z',
        cases: [
          {
            id: 'a',
            title: 'A',
            runs: [run(1, Outcome.Met, GateResult.Passed), run(2, Outcome.Met, GateResult.Passed)],
          },
          {
            id: 'b',
            title: 'B',
            runs: [
              run(1, Outcome.Failed, GateResult.Failed),
              run(2, Outcome.Met, GateResult.Passed),
            ],
          },
        ],
      },
      null,
    );
    const lines = markdown.split('\n');
    expect(lines.find((l) => l.startsWith('| b |'))).toContain('| failed, met | failed, passed |');
    expect(lines.find((l) => l.startsWith('| **Total** |'))).toContain(
      '| 3/4 met | 1 failed, 3 met | 1 failed, 3 passed | 4 approve | 4 | 8 | 0 | — | 40 / 20 / 0 | — | 12 s |',
    );
  });
});
