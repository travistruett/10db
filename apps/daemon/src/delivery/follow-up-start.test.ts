import { describe, expect, it } from 'vitest';
import { followUpStart, type FollowUpStart, type SourceState } from './follow-up-start';

// T4 call 13: where a follow-up of Run these now starts, read from the source as it stands when the
// follow-up starts. It never shares a branch another batch ships.

const source = (over: Partial<SourceState>): SourceState => ({
  batch: 'SHIPPED',
  readiness: 'ready',
  delivery: 'pull_request',
  pullRequest: 'open',
  ...over,
});
const base = (note: string | null = null): FollowUpStart => ({ kind: 'base', note });
const ABANDONED =
  "The source's work was abandoned, so it isn't on the base this follow-up starts from.";
const UNMERGED =
  "The source's pull request was closed without merging, so its work isn't on the base this follow-up starts from.";
const NEVER_PUSHED =
  "The source's work was never pushed, so it isn't on the base this follow-up starts from.";

describe('followUpStart', () => {
  it.each<[string, Partial<SourceState>, FollowUpStart]>([
    ['the batch is cutting', { batch: 'CUTTING' }, { kind: 'wait' }],
    ['the batch is shipping', { batch: 'SHIPPING' }, { kind: 'wait' }],
    [
      'an open batch with a member running',
      { batch: 'OPEN', readiness: 'blocked' },
      { kind: 'wait' },
    ],
    [
      'an open batch whose members settled',
      { batch: 'OPEN', readiness: 'ready' },
      { kind: 'join' },
    ],
    [
      'an open batch with a failed member',
      { batch: 'OPEN', readiness: 'ship_anyway' },
      { kind: 'join' },
    ],
    ['shipped and merged', { pullRequest: 'merged' }, base()],
    ['shipped, its pull request open', { pullRequest: 'open' }, { kind: 'wait' }],
    ['shipped, its pull request unread', { pullRequest: 'unknown' }, { kind: 'wait' }],
    ['shipped, its pull request closed unmerged', { pullRequest: 'closed' }, base(UNMERGED)],
    ['shipped locally', { delivery: 'local', pullRequest: null }, base()],
    ['closed', { batch: 'CLOSED' }, base()],
    [
      'its ship failed, the pull request open',
      { batch: 'FAILED', pullRequest: 'open' },
      { kind: 'wait' },
    ],
    [
      'its ship failed, the pull request merged',
      { batch: 'FAILED', pullRequest: 'merged' },
      base(),
    ],
    ['its ship failed before any push', { batch: 'FAILED', pullRequest: null }, base(NEVER_PUSHED)],
    ['abandoned', { batch: 'ABANDONED' }, base(ABANDONED)],
    ['a run with no batch', { batch: null, delivery: 'local', pullRequest: null }, base()],
  ])('%s', (_name, over, expected) => {
    expect(followUpStart(source(over))).toEqual(expected);
  });
});
