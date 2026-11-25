import { describe, expect, it } from 'vitest';
import { GateReport, parseGateReport } from './gate-report';
import { findEvalMarkers } from './markers';

describe('eval markers', () => {
  it('finds result files and definition files by name, and leaves the rest', () => {
    const found = findEvalMarkers([
      'amps/backend/evals/reports/chat.answer/20261013T091955865408Z.json',
      'evals/reports/chat.answer/latest.json',
      'apps/daemon/evals/lane-pipeline/baselines/standard.json',
      'amps/backend/evals/chat/answer.py',
      'amps/backend/evals/chat/__init__.py',
      'amps/backend/evals/chat/_helpers.py',
      'amps/backend/evals/reports/chat.answer/notes.py',
      'amps/backend/evals/chat.recorded/answer.py',
      'tests/eval/test_billing_eval.py',
      'tests/eval/test_billing.py',
      'plugin/evals/greets/prompt.md',
      'src/index.ts',
    ]);
    expect(found.reports).toEqual([
      {
        path: 'amps/backend/evals/reports/chat.answer/20261013T091955865408Z.json',
        folder: 'chat.answer',
        at: '2026-10-13T09:19:55.865Z',
      },
    ]);
    expect(found.baselines).toEqual([
      { path: 'apps/daemon/evals/lane-pipeline/baselines/standard.json', rigor: 'standard' },
    ]);
    expect(found.definitions).toEqual([
      'amps/backend/evals/chat/answer.py',
      'tests/eval/test_billing_eval.py',
    ]);
    expect([...found.promptCases]).toEqual([['plugin/evals', ['plugin/evals/greets/prompt.md']]]);
  });

  it('reads a gate report: slot, billed cost, and a trial failed by an assertion', () => {
    const report = GateReport.parse({
      task: 'chat.answer',
      version: 3,
      fingerprint: 'abc',
      repeat: 2,
      passed: false,
      slots: [
        {
          slot: 'SMART@medium',
          slug: 'vendor/model',
          passed: false,
          trials: 2,
          gates: { recall: { rate: 0.5, minimum: 0.8, passed: false, good: 1, total: 2 } },
          cost: { total: '0.25', basis: 'billed' },
          latency_ms: { p50: 100, p95: 200 },
          cases: [
            { name: 'a [1/2]', source_case: 'a', failed: false, assertions: { x: true } },
            { name: 'a [2/2]', source_case: 'a', failed: false, assertions: { x: false } },
          ],
        },
        { slot: 'same', slug: 'same', passed: true, gates: {}, cost: null },
      ],
    });
    const run = parseGateReport(report, 'p.json', '2026-10-13T09:19:55.865Z');
    expect(run.models.map((m) => [m.model, m.slot, m.costUsd])).toEqual([
      ['vendor/model', 'SMART@medium', 0.25],
      ['same', null, null],
    ]);
    expect(run.cases).toEqual([{ name: 'a (vendor/model)', trials: 2, failed: 1 }]);
  });
});
