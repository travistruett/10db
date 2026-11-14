import { describe, expect, it } from 'vitest';
import { stripLayout } from './strip-layout';

describe('stripLayout', () => {
  it.each([
    { width: 420, want: 'switcher' },
    { width: 639, want: 'switcher' },
    { width: 640, want: 'compact' },
    { width: 899, want: 'compact' },
    { width: 900, want: 'full' },
    { width: 1280, want: 'full' },
  ] as const)('$width px is $want', ({ width, want }) => {
    expect(stripLayout(width)).toBe(want);
  });
});
