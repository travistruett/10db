import { describe, expect, it } from 'vitest';
import { parseSuggestAnswer } from './suggest-answer';

describe('parseSuggestAnswer', () => {
  it('shows nothing for a reply that is malformed or too big, and reads a fenced good one', () => {
    expect(parseSuggestAnswer('cases', 'Sorry, I cannot do that.').ok).toBe(false);
    expect(parseSuggestAnswer('check', '{"check":"oracle","rule":"x"}').ok).toBe(false);
    expect(parseSuggestAnswer('tighten', `{"behavior":"${'a'.repeat(601)}"}`).ok).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      input: `case ${String(i)}`,
      reason: '',
    }));
    expect(parseSuggestAnswer('cases', JSON.stringify({ cases: eleven })).ok).toBe(false);
    expect(
      parseSuggestAnswer(
        'cases',
        'Here you go:\n```json\n{"cases":[{"input":"a","reason":"odd"}]}\n```',
      ),
    ).toEqual({ ok: true, answer: { kind: 'cases', cases: [{ input: 'a', reason: 'odd' }] } });
  });
});
