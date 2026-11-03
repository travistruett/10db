import { describe, expect, it } from 'vitest';
import {
  CHAT_MIN,
  DEFAULT_CHAT_SHARE,
  DRAWER_BELOW,
  chatShareAfterDrag,
  splitLayout,
} from './split-layout';

// Shape spec §4, D7: chat at least 420 px, sidebar at least 480, 45/55 by default; below 1100 px of
// content the sidebar is a drawer over the chat.

describe('splitLayout', () => {
  it.each([
    ['the default share of a wide window', 1400, DEFAULT_CHAT_SHARE, { mode: 'split', chat: 630 }],
    ['a chat held at its minimum', 1200, 0.2, { mode: 'split', chat: CHAT_MIN }],
    ['a sidebar held at its minimum', 1200, 0.9, { mode: 'split', chat: 1200 - 480 }],
    [
      'a drawer just under the breakpoint',
      DRAWER_BELOW - 1,
      DEFAULT_CHAT_SHARE,
      { mode: 'drawer' },
    ],
    ['a split at the breakpoint', DRAWER_BELOW, DEFAULT_CHAT_SHARE, { mode: 'split', chat: 495 }],
    ['a split before anything is measured', 0, DEFAULT_CHAT_SHARE, { mode: 'split', chat: null }],
  ])('gives %s', (_, width, share, expected) => {
    expect(splitLayout(width, share)).toEqual(expected);
  });
});

describe('chatShareAfterDrag', () => {
  it('turns a pointer position into a share, clamped to the minimums', () => {
    expect(chatShareAfterDrag(700, 1400)).toBeCloseTo(0.5);
    expect(chatShareAfterDrag(100, 1400)).toBeCloseTo(CHAT_MIN / 1400);
    expect(chatShareAfterDrag(1390, 1400)).toBeCloseTo((1400 - 480) / 1400);
  });

  it('keeps a share unchanged when nothing is measured', () => {
    expect(chatShareAfterDrag(300, 0)).toBe(DEFAULT_CHAT_SHARE);
  });
});
