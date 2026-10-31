import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SECRET_CHARACTERS } from '@10db/contracts';

export const KEYCHAIN_SERVICE = '10db';
/** The Keychain account of the builder's Artificial Analysis key. */
export const AA_KEY_ACCOUNT = 'artificial-analysis-api-key';
/** The Keychain account of the builder's OpenRouter key. */
export const OPENROUTER_KEY_ACCOUNT = 'openrouter-api-key';
const KEYCHAIN_TIMEOUT_MS = 5_000;
/** `security` exits with this status when the Keychain has no such item. */
const ITEM_NOT_FOUND = 44;
const SAFE_ACCOUNT = /^[A-Za-z0-9:_.-]+$/;
const FINGERPRINT_HEX = 16;

type KeychainExec = (
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

/** The Keychain could not be read or written. The message names the item and the status, never a value. */
export class KeychainError extends Error {
  override readonly name = 'KeychainError';
}

/** Items in the login Keychain under service `10db`. Secrets are read when needed and never cached. */
export interface Keychain {
  /** The secret, or null when the item is missing or empty. */
  read(account: string): string | null;
  /** Adds or replaces the item, then reads it back. */
  write(account: string, secret: string): void;
  /** Deletes the item; one that is already missing is not an error. */
  remove(account: string): void;
}

function failure(error: unknown): string {
  // Execution errors carry the command line and its output, which can hold a value; only the codes are used.
  const e = error as { status?: number | null; code?: string; signal?: string | null };
  if (e.code === 'ETIMEDOUT') return `timed out after ${String(KEYCHAIN_TIMEOUT_MS / 1000)} s`;
  if (typeof e.status === 'number') return `security exit status ${String(e.status)}`;
  return e.code ?? e.signal ?? 'unknown error';
}

/**
 * A Keychain over `exec`. Only "item not found" means there is no secret; a timeout, a locked or
 * unreachable Keychain or a denied prompt throws, because telling the builder to add a secret that
 * exists would send them the wrong way.
 */
export function keychainWith(exec: KeychainExec): Keychain {
  const read = (account: string): string | null => {
    try {
      const value = exec(
        '/usr/bin/security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS },
      ).trim();
      return value.length > 0 ? value : null;
    } catch (error) {
      // A thrown exec error has a numeric `status` when security ran and exited non-zero.
      if ((error as { status?: unknown }).status === ITEM_NOT_FOUND) return null;
      throw new KeychainError(`Reading the Keychain item ${account} failed (${failure(error)})`);
    }
  };
  return {
    read,
    write(account, secret) {
      if (!SAFE_ACCOUNT.test(account))
        throw new KeychainError(`${account} is not a Keychain account name 10db writes`);
      if (!SECRET_CHARACTERS.test(secret))
        throw new KeychainError(
          'The secret must be printable ASCII with no spaces, double quotes or backslashes',
        );
      try {
        // Interactive mode reads the command from standard input, so the secret is never on a command line.
        exec('/usr/bin/security', ['-i'], {
          encoding: 'utf8',
          input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "${account}" -w "${secret}"\n`,
          stdio: ['pipe', 'ignore', 'ignore'],
          timeout: KEYCHAIN_TIMEOUT_MS,
        });
      } catch (error) {
        throw new KeychainError(`Writing the Keychain item ${account} failed (${failure(error)})`);
      }
      // `security -i` can report a failed command without a failing exit status.
      if (read(account) !== secret)
        throw new KeychainError(`The Keychain did not store the secret for ${account} as given`);
    },
    remove(account) {
      if (!SAFE_ACCOUNT.test(account))
        throw new KeychainError(`${account} is not a Keychain account name 10db removes`);
      try {
        exec(
          '/usr/bin/security',
          ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'ignore', 'ignore'],
            timeout: KEYCHAIN_TIMEOUT_MS,
          },
        );
      } catch (error) {
        if ((error as { status?: unknown }).status === ITEM_NOT_FOUND) return;
        throw new KeychainError(`Removing the Keychain item ${account} failed (${failure(error)})`);
      }
    },
  };
}

export const systemKeychain: Keychain = keychainWith(execFileSync);

/** For a daemon started without a Keychain (tests): nothing to read, and writing is refused. */
export const unavailableKeychain: Keychain = {
  read: () => null,
  write: (account) => {
    throw new KeychainError(
      `No Keychain is available to this daemon, so ${account} was not written`,
    );
  },
  remove: (account) => {
    throw new KeychainError(
      `No Keychain is available to this daemon, so ${account} was not removed`,
    );
  },
};

/** Enough to tell two secrets apart, never enough to recover one. */
export function secretFingerprint(secret: string): string {
  return `sha256:${createHash('sha256').update(secret).digest('hex').slice(0, FINGERPRINT_HEX)}`;
}
