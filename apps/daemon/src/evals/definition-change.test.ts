import { EvalDefinitionChangeKind as Kind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { classifyDefinitionChange, definitionHit, definitionReason } from './definition-change';

const patch = (lines: string[]): string => `@@ -1,5 +1,5 @@\n${lines.join('\n')}\n`;
const kinds = (path: string, lines: string[]): string[] =>
  classifyDefinitionChange(path, patch(lines)).map((c) => c.kind);

describe('classifyDefinitionChange', () => {
  it('reads each kind from the lines of the patch', () => {
    expect(
      kinds('evals/gate.py', ['-MIN = dict(minimum_rate=0.9)', '+MIN = dict(minimum_rate=0.5)']),
    ).toEqual([Kind.BarLowered]);
    expect(kinds('evals/gate.py', ['-    threshold: 0.5', '+    threshold: 0.8'])).toEqual([
      Kind.Unclassified,
    ]);
    expect(kinds('evals/suite.py', ['-    Case("a", "x"),', ' Case("b", "y"),'])).toEqual([
      Kind.CasesRemoved,
    ]);
    expect(kinds('evals/cases.jsonl', ['-{"id": 1}', '-{"id": 2}', '+{"id": 3}'])).toEqual([
      Kind.CasesRemoved,
    ]);
    expect(kinds('evals/suite.py', ['-    expected="yes",', '+    expected="no",'])).toEqual([
      Kind.GoldenChanged,
    ]);
    expect(kinds('evals/golden/a.txt', ['+text'])).toEqual([Kind.GoldenChanged]);
    expect(kinds('evals/scorer.py', ['-return 1', '+return 0'])).toEqual([Kind.GraderChanged]);
    expect(kinds('evals/suite.py', ['-    return a == b', '+    return a in b'])).toEqual([
      Kind.Unclassified,
    ]);
    expect(kinds('evals/suite.py', ['+judge = llm_judge(model="claude-opus-4")'])).toEqual([
      Kind.ModelJudgeAdded,
    ]);
  });

  it('reads the two sides of each changed bar line, not the first number it finds', () => {
    // A second gate lowered after a first one raised.
    expect(
      kinds('evals/gates.py', [
        '-    "a": dict(minimum_rate=0.5),',
        '-    "b": dict(minimum_rate=0.9),',
        '+    "a": dict(minimum_rate=0.7),',
        '+    "b": dict(minimum_rate=0.6),',
      ]),
    ).toEqual([Kind.BarLowered]);
    // Two bars on one line, the second lowered.
    expect(
      kinds('evals/gate.py', [
        '-G = dict(minimum_rate=0.9, threshold=0.8)',
        '+G = dict(minimum_rate=0.9, threshold=0.6)',
      ]),
    ).toEqual([Kind.BarLowered]);
    // Gates reordered: every line is still there.
    expect(
      kinds('evals/gates.py', [
        '-    "a": dict(minimum_rate=0.9),',
        '-    "b": dict(minimum_rate=0.5),',
        '+    "b": dict(minimum_rate=0.5),',
        '+    "a": dict(minimum_rate=0.9),',
      ]),
    ).toEqual([Kind.Unclassified]);
    // Lowered in one range and restored in another of the same file.
    const twoRanges = `${patch(['-minimum_rate=0.9', '+minimum_rate=0.5'])}${patch(['-minimum_rate=0.5', '+minimum_rate=0.9'])}`;
    expect(classifyDefinitionChange('evals/gate.py', twoRanges).map((c) => c.kind)).toEqual([
      Kind.Unclassified,
    ]);
    // Spelled other ways, or deleted outright.
    expect(kinds('evals/gate.py', ['-MINIMUM_RATE = 0.9', '+MINIMUM_RATE = .5'])).toEqual([
      Kind.BarLowered,
    ]);
    expect(
      kinds('evals/gate.py', ['-    minimum_rate: float = 0.9', '+    minimum_rate: float = 0.5']),
    ).toEqual([Kind.BarLowered]);
    expect(kinds('evals/gate.py', ['-pass_threshold = 0.9', '+pass_threshold = 0.8'])).toEqual([
      Kind.BarLowered,
    ]);
    expect(kinds('evals/gate.py', ['-minimum_rate=0.9'])).toEqual([Kind.BarLowered]);
  });

  it('does not read an edit, a reformat or a look-alike as a removal or a change', () => {
    expect(kinds('evals/suite.py', ['-Case("a", "x")', '+Case("a", "x ")'])).toEqual([
      Kind.Unclassified,
    ]);
    expect(
      kinds('evals/cases.json', [
        '-[',
        '-  {"id": 1},',
        '-  {"id": 2}',
        '-]',
        '+[{"id": 1}, {"id": 2}]',
      ]),
    ).toEqual([Kind.Unclassified]);
    expect(kinds('evals/suite.py', ['+    Case("n", "x", expected="y"),'])).toEqual([
      Kind.Unclassified,
    ]);
    expect(
      kinds('evals/suite.py', [
        '-    return expected == got',
        '+    return expected == got.strip()',
      ]),
    ).toEqual([Kind.Unclassified]);
    expect(
      kinds('evals/suite.py', ['-def grade(expected: str):', '+def check(expected: str):']),
    ).toEqual([Kind.GraderChanged]);
    expect(kinds('evals/underscore_names.py', ['-a = 1', '+a = 2'])).toEqual([Kind.Unclassified]);
    expect(kinds('evals/upgrade.py', ['-a = 1', '+a = 2'])).toEqual([Kind.Unclassified]);
    expect(kinds('evals/suite.py', ['-def upgrade_model():', '+def upgrade_models():'])).toEqual([
      Kind.Unclassified,
    ]);
    expect(
      kinds('evals/suite.py', [
        '-judge = llm_judge(a)',
        '+judge = llm_judge(a, b)',
        '+# judge: be strict',
      ]),
    ).toEqual([Kind.Unclassified]);
    // A later file's header inside the same patch is not a changed line.
    const joined = `${patch(['-a = 1', '+a = 2'])}diff --git a/x b/x\n--- a/x\n+++ b/x\n`;
    expect(classifyDefinitionChange('evals/suite.py', joined).map((c) => c.kind)).toEqual([
      Kind.Unclassified,
    ]);
  });

  it('says unclassified for a change no rule reads, and names the line it read', () => {
    const changes = classifyDefinitionChange('evals/suite.py', patch(['-a = 1', '+a = 2']));
    expect(changes).toEqual([{ kind: Kind.Unclassified, line: '' }]);
    const lowered = classifyDefinitionChange(
      'evals/gate.py',
      patch(['-minimum_rate=0.9', '+minimum_rate=0.5']),
    );
    expect(definitionHit('gate', lowered).reason).toBe('bar lowered (minimum_rate=0.5)');
    expect(definitionHit('gate', changes).reason).toBe('definition changed, unclassified');
    expect(definitionHit('gate', changes, true).reason).toBe(
      'definition changed, not read in full',
    );
    expect(definitionReason(lowered, true)).toBe('bar lowered (`minimum_rate=0.5`)');
  });

  it('reads a long line a lane wrote in bounded time', () => {
    const long = '_threshold'.repeat(3200);
    expect(kinds('evals/gate.py', [`-${long} = x`, `+${long} = y`])).toEqual([Kind.Unclassified]);
  });
});
