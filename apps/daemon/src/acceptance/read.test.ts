import { describe, expect, it } from 'vitest';
import type { AcceptanceCriterionResult, AcceptanceVerdict } from '@10db/contracts';
import { AcceptanceMove, acceptanceMove, readAcceptance, secondQuestions } from './read';

const A = 'adds the flag';
const B = 'prints the help';
const C = 'exits 0';
const none = new Set<string>();

const verdicts = (rs: readonly AcceptanceCriterionResult[]) => rs.map((r) => r.verdict);

describe('readAcceptance', () => {
  const read = (over: Partial<Parameters<typeof readAcceptance>[0]>) =>
    readAcceptance({
      criteria: [A, B, C],
      accepted: none,
      first: null,
      second: null,
      firstFloor: 0.8,
      secondFloor: 0.7,
      ...over,
    });

  it('settles met on the first call and sends the rest to the second', () => {
    const first = { [A]: 0.9, [B]: 0.6, [C]: 0.1 };
    expect(secondQuestions([A, B, C], none, first, 0.8)).toEqual([B, C]);
    const out = read({ first, second: { [B]: 0.75, [C]: 0.1 } });
    expect(verdicts(out)).toEqual(['met', 'met', 'not_met']);
    expect(out[2]?.note).toBe('read as not met (0.10, second opinion)');
  });

  it('reads the second at its floor: met, not met, or unclear between', () => {
    const out = read({ first: {}, second: { [A]: 0.7, [B]: 0.3, [C]: 0.5 } });
    expect(verdicts(out)).toEqual(['met', 'not_met', 'unclear']);
  });

  it('counts an accepted criterion as met and never asks about it', () => {
    expect(secondQuestions([A, B], new Set([A]), null, 0.8)).toEqual([B]);
    const out = read({ accepted: new Set([A]), first: {}, second: { [B]: 0.1, [C]: 0.1 } });
    expect(out[0]).toEqual({ criterion: A, verdict: 'met', note: 'accepted by the builder' });
  });

  it('sends everything unaccepted to the second when the first gave no answer, and leaves it unread when neither did', () => {
    expect(secondQuestions([A, B], none, null, 0.8)).toEqual([A, B]);
    expect(verdicts(read({}))).toEqual(['unread', 'unread', 'unread']);
    expect(verdicts(read({ first: { [A]: 0.95, [B]: 0.95, [C]: 0.95 } }))).toEqual([
      'met',
      'met',
      'met',
    ]);
    expect(verdicts(read({ first: { [A]: 0.95, [B]: 0.2, [C]: 0.95 } }))).toEqual([
      'met',
      'unread',
      'met',
    ]);
  });

  it('clamps a floor under one half to one half', () => {
    expect(secondQuestions([A], none, { [A]: 0.55 }, 0.1)).toEqual([]);
    expect(secondQuestions([A], none, { [A]: 0.45 }, 0.1)).toEqual([A]);
    const out = read({ first: {}, second: { [A]: 0.55, [B]: 0.45, [C]: 0.5 }, secondFloor: 0.1 });
    expect(verdicts(out)).toEqual(['met', 'not_met', 'met']);
  });
});

describe('acceptanceMove', () => {
  const rs = (...v: AcceptanceVerdict[]): AcceptanceCriterionResult[] =>
    v.map((verdict, i) => ({ criterion: `c${String(i)}`, verdict, note: '' }));
  const move = (results: AcceptanceCriterionResult[], reviewFollows: boolean, atLimit: boolean) =>
    acceptanceMove({ results, reviewFollows, atLimit });

  it('sends back on not met, goes on with a card at the limit or an unclear one with no review', () => {
    expect(move(rs('met', 'not_met'), true, false)).toBe(AcceptanceMove.SendBack);
    expect(move(rs('not_met'), true, true)).toBe(AcceptanceMove.GoOnWithCard);
    expect(move(rs('unclear'), false, false)).toBe(AcceptanceMove.GoOnWithCard);
    expect(move(rs('unclear'), true, false)).toBe(AcceptanceMove.GoOn);
    expect(move(rs('met', 'unread'), false, false)).toBe(AcceptanceMove.GoOn);
    expect(move(rs('unread', 'unclear'), false, true)).toBe(AcceptanceMove.GoOnWithCard);
  });
});
