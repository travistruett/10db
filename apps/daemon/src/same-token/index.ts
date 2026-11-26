import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/**
 * Whether a presented bearer token is the expected one. Both sides are hashed first, so the comparison runs in
 * constant time, never throws on tokens of different byte lengths, and doesn't tell their lengths apart.
 */
export function sameToken(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}
