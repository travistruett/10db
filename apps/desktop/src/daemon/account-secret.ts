import { AccountDto, type AccountId, type AccountSecretInput } from '@10db/contracts';
import { readJson, type DaemonClient } from './client';

/**
 * Sends an account's secret to the daemon, which writes it to the Keychain. A plain function rather
 * than a mutation hook: TanStack keeps a mutation's variables in its cache after the request ends.
 * The caller refreshes the account list afterwards; nothing here touches a cache.
 */
export async function sendAccountSecret(
  client: DaemonClient,
  id: AccountId,
  input: AccountSecretInput,
): Promise<AccountDto> {
  return readJson(
    await client.accounts[':accountId'].secret.$put({ param: { accountId: id }, json: input }),
    AccountDto,
  );
}
