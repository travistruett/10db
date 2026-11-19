import { describe, expect, it } from 'vitest';
import type { HandoffDto } from '@10db/contracts';
import {
  handoffStands,
  nextUnaskedRun,
  UNASKED_HANDOFF_LIMIT,
  workLeftIn,
  type HandoffFacts,
} from './handoff-rule';

const facts = (over: Partial<HandoffFacts>): HandoffFacts => ({
  asked: false,
  readOnly: false,
  resultRecorded: false,
  leftNamed: false,
  uncommitted: false,
  ...over,
});

describe('handoffStands', () => {
  it('stands when asked, or unasked while work is named left or uncommitted, and a read-only step only before its result', () => {
    const rows: [string, Partial<HandoffFacts>, boolean][] = [
      ['asked, with nothing left or uncommitted', { asked: true }, true],
      [
        'asked, in a read-only step with its result',
        { asked: true, readOnly: true, resultRecorded: true },
        true,
      ],
      ['unasked, naming nothing and nothing uncommitted', {}, false],
      ['unasked, naming work left', { leftNamed: true }, true],
      ['unasked, with changes uncommitted', { uncommitted: true }, true],
      [
        'unasked read-only, naming work left with no result',
        { readOnly: true, leftNamed: true },
        true,
      ],
      [
        'unasked read-only, naming work left after its result',
        { readOnly: true, leftNamed: true, resultRecorded: true },
        false,
      ],
      ['unasked read-only, naming nothing with no result', { readOnly: true }, false],
      [
        'unasked read-only, ignoring uncommitted changes',
        { readOnly: true, uncommitted: true },
        false,
      ],
    ];
    for (const [name, over, stands] of rows) {
      expect.soft(handoffStands(facts(over)), name).toBe(stands);
    }
  });
});

describe('nextUnaskedRun', () => {
  it('counts unasked handoffs at one commit up to the limit, and starts again after a commit', () => {
    const rows: [string, { gitHead: string; count: number } | null, string, number, boolean][] = [
      ['the first starts a run', null, 'h1', 1, false],
      ['one more at the same commit grows it', { gitHead: 'h1', count: 1 }, 'h1', 2, false],
      [
        'the limit at the same commit stops it',
        { gitHead: 'h1', count: UNASKED_HANDOFF_LIMIT - 1 },
        'h1',
        UNASKED_HANDOFF_LIMIT,
        true,
      ],
      [
        'a commit between starts again',
        { gitHead: 'h1', count: UNASKED_HANDOFF_LIMIT - 1 },
        'h2',
        1,
        false,
      ],
    ];
    for (const [name, run, gitHead, count, atLimit] of rows) {
      const next = nextUnaskedRun(run, gitHead);
      expect.soft(next.run, `${name}: run`).toEqual({ gitHead, count });
      expect.soft(next.atLimit, `${name}: at limit`).toBe(atLimit);
    }
  });
});

describe('workLeftIn', () => {
  it('names the work not done and the blockers a handoff lists', () => {
    const handoff = (notDone: string[], blockers: string[]) =>
      ({
        content: { progress: { notDone }, continuity: { blockers } },
      }) as unknown as HandoffDto; // Only the two fields read here.
    const rows: [string, string[], string[], string[]][] = [
      ['nothing named', [], [], []],
      ['work not done', ['the 409 case'], [], ['the 409 case']],
      [
        'a blocker, with nothing listed as not done',
        [],
        ['src held by a parked lane'],
        ['src held by a parked lane'],
      ],
      ['both', ['the 409 case'], ['a question'], ['the 409 case', 'a question']],
    ];
    for (const [name, notDone, blockers, left] of rows) {
      expect.soft(workLeftIn(handoff(notDone, blockers)), name).toEqual(left);
    }
  });
});
