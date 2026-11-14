import { describe, expect, it } from 'vitest';
import { screenAlt } from './screen-alt';

// Workbench spec §4.6, §10: each picture says what it shows to a screen reader.

const size = { width: 1440, height: 900 };

describe('screenAlt', () => {
  it.each([
    {
      name: 'a before',
      screen: { kind: 'before', turnSeq: null, theme: 'default', ...size },
      alt: 'Settings before, 1440 by 900',
    },
    {
      name: 'a turn picture',
      screen: { kind: 'turn', turnSeq: 3, theme: 'default', ...size },
      alt: 'Settings after, turn 3, 1440 by 900',
    },
    {
      name: 'an after',
      screen: { kind: 'after', turnSeq: null, theme: 'default', ...size },
      alt: 'Settings after sign-off, 1440 by 900',
    },
    {
      name: 'a theme other than the default',
      screen: { kind: 'before', turnSeq: null, theme: 'dark', width: 390, height: 844 },
      alt: 'Settings before, 390 by 844, dark theme',
    },
  ] as const)('$name', ({ screen, alt }) => {
    expect(screenAlt('Settings', screen)).toBe(alt);
  });
});
