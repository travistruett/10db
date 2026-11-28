import { describe, expect, it } from 'vitest';
import { JudgeCallError } from './credential';
import { parseSessionChoice, parseSessionNouls } from './session-answer';

const choiceQ = { options: ['review', 'skip'] } as const;
const noulQ = {
  questions: {
    crosses: { instructions: 'Does it cross?', criteria: { true: 'Yes.', false: 'No.' } },
    reversible: { instructions: 'Can it be undone?', criteria: { true: 'Yes.', false: 'No.' } },
  },
};

describe('a session judge answer', () => {
  it('reads a fenced choice in prose, matching the option ignoring case and clamping the confidence', () => {
    const text = 'Here is my answer:\n```json\n{"choice": "SKIP", "confidence": 1.7}\n```\nDone.';
    expect(parseSessionChoice(choiceQ, text, 'claude-haiku')).toEqual({
      choice: 'skip',
      confidence: 1,
      model: 'claude-haiku',
      costUsd: null,
    });
    expect(
      parseSessionNouls(noulQ, 'Sure. {"crosses": 0.1, "reversible": 0.8}', 'gpt-mini'),
    ).toEqual({
      probabilities: { crosses: 0.1, reversible: 0.8 },
      model: 'gpt-mini',
      costUsd: null,
    });
  });

  it('fails on an unoffered option, a non-JSON reply, a missing question or a string probability', () => {
    expect(() => parseSessionChoice(choiceQ, '{"choice":"merge","confidence":0.9}', 'm')).toThrow(
      JudgeCallError,
    );
    expect(() => parseSessionChoice(choiceQ, 'I would skip it.', 'm')).toThrow(JudgeCallError);
    expect(() => parseSessionNouls(noulQ, '{"crosses": 0.1}', 'm')).toThrow(JudgeCallError);
    expect(() => parseSessionNouls(noulQ, '{"crosses": 0.1, "reversible": "0.9"}', 'm')).toThrow(
      JudgeCallError,
    );
  });
});
