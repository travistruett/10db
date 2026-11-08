import { describe, expect, it } from 'vitest';
import {
  handoffStands,
  nextUnaskedRun,
  UNASKED_HANDOFF_LIMIT,
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
  it.each<[string, Partial<HandoffFacts>, boolean]>([
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
  ])('%s: %s', (_name, over, stands) => {
    expect(handoffStands(facts(over))).toBe(stands);
  });
});

describe('nextUnaskedRun', () => {
  it.each<[string, { gitHead: string; count: number } | null, string, number, boolean]>([
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
  ])('%s', (_name, run, gitHead, count, atLimit) => {
    const next = nextUnaskedRun(run, gitHead);
    expect(next.run).toEqual({ gitHead, count });
    expect(next.atLimit).toBe(atLimit);
  });
});
