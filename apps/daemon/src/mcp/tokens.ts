import { createHash, randomBytes } from 'node:crypto';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A per-session bearer token; only its hash is stored. */
export function mintSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
