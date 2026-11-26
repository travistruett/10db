import { describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { PairAttempt, createPairingCodes } from './pairing-codes';

function setup() {
  const clock = new ManualClock();
  return { clock, codes: createPairingCodes({ clock }) };
}

describe('pairing codes', () => {
  it('spends the code on a match', () => {
    const { codes } = setup();
    const { code } = codes.open();
    expect(codes.attempt(code)).toBe(PairAttempt.Ok);
    expect(codes.attempt(code)).toBe(PairAttempt.Refused);
  });

  it('burns the code on the fifth wrong try', () => {
    const { codes } = setup();
    const { code } = codes.open();
    for (let i = 0; i < 5; i += 1) expect(codes.attempt('WRONG123')).toBe(PairAttempt.Refused);
    expect(codes.attempt(code)).toBe(PairAttempt.Refused);
  });

  it('counts a too-long code as a wrong try', () => {
    const { codes } = setup();
    const { code } = codes.open();
    for (let i = 0; i < 5; i += 1) expect(codes.attempt(`${code}X`)).toBe(PairAttempt.Refused);
    expect(codes.attempt(code)).toBe(PairAttempt.Refused);
  });

  it('refuses the code after 5 minutes', () => {
    const { clock, codes } = setup();
    const { code } = codes.open();
    clock.advance(5 * 60_000);
    expect(codes.attempt(code)).toBe(PairAttempt.Refused);
  });

  it('rate-limits the 11th try in a minute before reading the code', () => {
    const clock = new ManualClock();
    const codes = createPairingCodes({ clock, random: () => Buffer.alloc(8, 7) });
    const { code } = codes.open();
    for (let i = 0; i < 10; i += 1) {
      expect(codes.attempt('WRONG123')).toBe(PairAttempt.Refused);
      if (i % 4 === 3) codes.open();
    }
    expect(codes.attempt(code)).toBe(PairAttempt.RateLimited);
    clock.advance(60_000);
    codes.open();
    expect(codes.attempt(code)).toBe(PairAttempt.Ok);
  });
});
