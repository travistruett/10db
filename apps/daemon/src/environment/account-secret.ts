import type { Keychain } from './keychain';
import { secretFingerprint } from './keychain';

/** What an account's Keychain secret is: usable, absent, or different from what 10db recorded. */
export type AccountSecret =
  { readonly state: 'set'; readonly secret: string } | { readonly state: 'missing' | 'changed' };

interface SecretHolder {
  readonly secretRef: string | null;
  readonly secretFingerprint: string | null;
}

/** The one check every account secret passes: recorded through 10db, present, and unchanged since. */
function judge(account: SecretHolder, secret: string | null): AccountSecret {
  if (secret === null) return { state: 'missing' };
  if (secretFingerprint(secret) !== account.secretFingerprint) return { state: 'changed' };
  return { state: 'set', secret };
}

export function readAccountSecret(account: SecretHolder, keychain: Keychain): AccountSecret {
  if (account.secretRef === null || account.secretFingerprint === null) return { state: 'missing' };
  return judge(account, keychain.read(account.secretRef));
}

/** `readAccountSecret` without blocking the event loop, for a request or a decision. */
export async function readAccountSecretAsync(
  account: SecretHolder,
  keychain: Keychain,
): Promise<AccountSecret> {
  if (account.secretRef === null || account.secretFingerprint === null) return { state: 'missing' };
  return judge(account, await keychain.readAsync(account.secretRef));
}
