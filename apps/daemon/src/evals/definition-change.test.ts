import { EvalDefinitionChangeKind as Kind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { classifyDefinitionChange, definitionHit } from './definition-change';

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

  it('says unclassified for a change no rule reads, and names the line it read', () => {
    const changes = classifyDefinitionChange('evals/suite.py', patch(['-a = 1', '+a = 2']));
    expect(changes).toEqual([{ kind: Kind.Unclassified, line: '' }]);
    const lowered = classifyDefinitionChange(
      'evals/gate.py',
      patch(['-minimum_rate=0.9', '+minimum_rate=0.5']),
    );
    expect(definitionHit('gate', lowered).reason).toBe('bar lowered (`minimum_rate=0.5`)');
    expect(definitionHit('gate', changes).reason).toBe('definition changed, unclassified');
  });
});
