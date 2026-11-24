import { describe, expect, it } from 'vitest';
import { goalLiveLine, type LiveWord } from './live-state';

const word = (w: string): LiveWord => ({ word: w, color: 'gray' });

describe('goalLiveLine', () => {
  it('counts every word a task can have, including the multi-word ones', () => {
    expect(goalLiveLine([word('In Review'), word('In Review')])).toBe('2 in review');
    expect(goalLiveLine([word('Needs You'), word('Done')])).toBe('1 needs you · 1 done');
  });
});
