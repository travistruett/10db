import { Rigor, Verdict } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { GateResult, Outcome } from './grade';
import { EvalAgent, renderReport, type CaseRun } from './report';

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

describe('renderReport', () => {
  it('lists a case’s runs in order and counts them in the total', () => {
    const markdown = renderReport(
      {
        rigor: Rigor.Standard,
        agent: EvalAgent.Fake,
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
