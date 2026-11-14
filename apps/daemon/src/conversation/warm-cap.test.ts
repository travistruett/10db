import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { warmToClose } from './warm-cap';

// Sessions spec §6.6: past the cap of idle warm sessions, the one idle longest closes.

const ids = Array.from({ length: 5 }, () => mintId('Conversation'));
const warm = (...idle: number[]) =>
  idle.map((idleSince, i) => ({ id: ids[i] ?? mintId('Conversation'), idleSince }));

describe('warmToClose', () => {
  it.each([
    { name: 'four warm: none closes', warm: warm(5, 1, 3, 2), closes: null },
    { name: 'five warm: the longest idle closes', warm: warm(5, 4, 1, 3, 2), closes: ids[2] },
    { name: 'a tie: the first of them closes', warm: warm(5, 1, 4, 1, 2), closes: ids[1] },
  ])('$name', ({ warm: w, closes }) => {
    expect(warmToClose(w, 4)).toBe(closes);
  });
});
