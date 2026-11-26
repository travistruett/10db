import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DeviceId } from '@10db/contracts';

const PREFIX = 'tdb_';
/** `dev_` plus a 36-character UUIDv7. */
const ID_LENGTH = 40;
/** 32 random bytes in unpadded base64url. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

/** A device's bearer token and the hash the database keeps in its place. */
export function mintDeviceToken(id: DeviceId): {
  readonly token: string;
  readonly tokenHash: string;
} {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${PREFIX}${id}_${secret}`, tokenHash: sha256(secret).toString('hex') };
}

/**
 * Splits a token by the id's fixed length, because the secret is base64url and may hold `_`. Returns null for
 * any other shape; never throws.
 */
export function parseDeviceToken(
  text: string,
): { readonly deviceId: DeviceId; readonly secret: string } | null {
  if (!text.startsWith(PREFIX)) return null;
  const rest = text.slice(PREFIX.length);
  if (rest.charAt(ID_LENGTH) !== '_') return null;
  const id = DeviceId.safeParse(rest.slice(0, ID_LENGTH));
  const secret = rest.slice(ID_LENGTH + 1);
  if (!id.success || !SECRET.test(secret)) return null;
  return { deviceId: id.data, secret };
}

/** Compares the presented secret's SHA-256 with the stored hash in constant time. */
export function secretMatches(secret: string, tokenHash: string): boolean {
  const stored = Buffer.from(tokenHash, 'hex');
  const presented = sha256(secret);
  return stored.length === presented.length && timingSafeEqual(stored, presented);
}
