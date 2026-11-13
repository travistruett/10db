import { describe, expect, it } from 'vitest';
import { codexCommandOf, type CodexCommandCall } from './codex-commands';

const COMPACT: CodexCommandCall = { method: 'thread/compact/start' };

describe('codexCommandOf', () => {
  it.each<[string, CodexCommandCall | null]>([
    ['/compact', COMPACT],
    ['  /compact  ', COMPACT],
    ['/compact now', COMPACT],
    ['/review', { method: 'review/start', target: { type: 'uncommittedChanges' } }],
    [
      '/review focus on auth',
      { method: 'review/start', target: { type: 'custom', instructions: 'focus on auth' } },
    ],
    ['/model', null],
    ['/Compact', null],
    ['please /compact', null],
    ['/unknown', null],
  ])('%j', (text, expected) => {
    expect(codexCommandOf(text)).toEqual(expected);
  });
});
