import { describe, expect, it } from 'vitest';
import type { AcceptanceCriterionResult, AcceptanceVerdict } from '@10db/contracts';
import {
  AcceptanceMove,
  acceptanceMove,
  readAcceptance,
  secondQuestions,
  unaskedDescription,
} from './read';
import { proofNeedsHands } from './hands';

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
      judgeable: null,
      firstFloor: 0.8,
      secondFloor: 0.7,
      ...over,
    });

  it('settles met on the first call and sends the rest to the second', () => {
    const first = { [A]: 0.9, [B]: 0.6, [C]: 0.1 };
    expect(secondQuestions([A, B, C], none, first, 0.8)).toEqual([B, C]);
    const out = read({ first, second: { [B]: 0.75, [C]: 0.1 } });
    expect(verdicts(out)).toEqual(['met', 'met', 'not_met']);
    expect(out[2]?.note).toBe('read as not met');
  });

  it('reads the second at its floor: met, not met, or unclear between', () => {
    const out = read({ first: {}, second: { [A]: 0.7, [B]: 0.3, [C]: 0.5 } });
    expect(verdicts(out)).toEqual(['met', 'not_met', 'unclear']);
  });

  it('reads not met only for a criterion the change can be judged on; otherwise unclear', () => {
    const second = { [A]: 0.05, [B]: 0.05, [C]: 0.9 };
    const out = read({ first: {}, second, judgeable: { [A]: 0.9, [B]: 0.25, [C]: 0.1 } });
    expect(verdicts(out)).toEqual(['not_met', 'unclear', 'met']);
    expect(out[1]?.note).toBe("can't be judged from the change");
    expect(verdicts(read({ first: {}, second, judgeable: { [A]: 0.7, [B]: 0.7 } }))).toEqual([
      'not_met',
      'not_met',
      'met',
    ]);
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

  it('sends an unproven criterion back for proof while the budget lasts, and raises a card only when it is spent', () => {
    expect(move(rs('met', 'not_met'), true, false)).toBe(AcceptanceMove.SendBack);
    expect(move(rs('not_met'), true, true)).toBe(AcceptanceMove.GoOnWithCard);
    expect(move(rs('unclear'), false, false)).toBe(AcceptanceMove.SendBack);
    expect(move(rs('unclear'), true, false)).toBe(AcceptanceMove.GoOn);
    expect(move(rs('met', 'unread'), false, false)).toBe(AcceptanceMove.GoOn);
    expect(move(rs('unread', 'unclear'), false, true)).toBe(AcceptanceMove.GoOnWithCard);
  });

  it('raises the your-hands card at once for a criterion only the builder can prove', () => {
    const hands: AcceptanceCriterionResult[] = [
      { criterion: 'the picker works on a real device', verdict: 'not_met', note: '' },
    ];
    expect(move(hands, true, false)).toBe(AcceptanceMove.GoOnWithCard);
    const mixed = [...hands, ...rs('not_met')];
    expect(move(mixed, true, false)).toBe(AcceptanceMove.SendBack);
    expect(move(mixed, true, true)).toBe(AcceptanceMove.GoOnWithCard);
    const unclearHands: AcceptanceCriterionResult[] = [
      { criterion: 'it works on the host', verdict: 'unclear', note: '' },
    ];
    expect(move(unclearHands, true, false)).toBe(AcceptanceMove.GoOnWithCard);
  });
});

describe('proofNeedsHands', () => {
  it('names what to do for a device, the host or a sign-in, and nothing for a criterion a session can prove', () => {
    expect(proofNeedsHands('the picker works on a real device')).toBe(
      'Try it on your device, then check that: the picker works on a real device',
    );
    expect(proofNeedsHands('the build runs on the host')).toContain('Run it on your Mac');
    expect(proofNeedsHands('a user signed in to Linear sees the issue')).toContain('Sign in');
    expect(proofNeedsHands('the sign-in page shows an error for a bad password')).toBeNull();
    expect(proofNeedsHands('adds the flag')).toBeNull();
  });
});

describe('unaskedDescription', () => {
  it('has nothing to say for a reading that is only a likelihood, so the card shows no empty line', () => {
    expect(
      unaskedDescription("The change may do something the task didn't ask for (0.97)."),
    ).toBeNull();
    expect(unaskedDescription("The change may do something the task didn't ask for.")).toBeNull();
    expect(unaskedDescription('It also logs the name.')).toBe('It also logs the name.');
    expect(unaskedDescription(null)).toBeNull();
  });
});
