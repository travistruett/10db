import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../clock';

export const PairAttempt = { Ok: 'ok', Refused: 'refused', RateLimited: 'rate_limited' } as const;
export type PairAttempt = (typeof PairAttempt)[keyof typeof PairAttempt];

export interface PairingCodes {
  /** A new code; cancels the open one. 5 minutes, single use, 5 wrong tries. */
  open(): { readonly code: string; readonly expiresAt: Date };
  /** Counts the try against the listener-wide limit (10 a minute) before looking at the code. */
  attempt(code: string): PairAttempt;
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const LIFETIME_MS = 5 * 60_000;
const WRONG_TRIES = 5;
const TRIES_PER_WINDOW = 10;
const WINDOW_MS = 60_000;

function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

/** 8 characters from 32 symbols: each byte's low 5 bits are uniform, so there is no modulo bias. */
function generate(random: (bytes: number) => Buffer): string {
  const bytes = random(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET.charAt((bytes[i] ?? 0) & 31);
  return code;
}

interface OpenCode {
  readonly hash: Buffer;
  readonly expiresAt: Date;
  wrong: number;
  spent: boolean;
}

export function createPairingCodes(deps: {
  readonly clock: Clock;
  readonly random?: (bytes: number) => Buffer;
}): PairingCodes {
  const random = deps.random ?? randomBytes;
  let open: OpenCode | null = null;
  let tries: number[] = [];

  return {
    open() {
      const code = generate(random);
      const expiresAt = new Date(deps.clock.now().getTime() + LIFETIME_MS);
      open = { hash: digest(code), expiresAt, wrong: 0, spent: false };
      return { code, expiresAt };
    },
    attempt(code) {
      const now = deps.clock.now().getTime();
      tries = tries.filter((at) => now - at < WINDOW_MS);
      if (tries.length >= TRIES_PER_WINDOW) return PairAttempt.RateLimited;
      tries.push(now);

      const current = open;
      if (current === null || current.spent || now >= current.expiresAt.getTime())
        return PairAttempt.Refused;
      const matches = code.length === CODE_LENGTH && timingSafeEqual(digest(code), current.hash);
      if (!matches) {
        current.wrong += 1;
        if (current.wrong >= WRONG_TRIES) current.spent = true;
        return PairAttempt.Refused;
      }
      current.spent = true;
      return PairAttempt.Ok;
    },
  };
}
