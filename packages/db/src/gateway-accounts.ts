import { z } from 'zod';
import { SchemaMismatchError, type TendbDatabase } from './database';

/** The kind a retired account type was stored under. It is no longer a `SupportedAccountKind`. */
const GATEWAY_KIND = 'gateway';

const GatewayRow = z.object({ id: z.string(), label: z.string() });

/** The database holds an account of a kind 10db no longer supports, so no account could be parsed. */
export class GatewayAccountError extends SchemaMismatchError {
  override readonly name = 'GatewayAccountError';
  readonly accountId: string;

  constructor(path: string, account: { readonly id: string; readonly label: string }) {
    super(
      path,
      `Account "${account.label}" (${account.id}) is a Gateway account, which 10db no longer supports. Remove it from the database and start again.`,
    );
    this.accountId = account.id;
  }
}

/**
 * Refuses a database that still holds a Gateway account. Read with a raw query because the narrowed
 * account kind type never parses it; nothing is converted or deleted.
 */
export function refuseGatewayAccounts(db: TendbDatabase): void {
  const row = db.$client
    .prepare('SELECT id, label FROM accounts WHERE kind = ? ORDER BY created_at LIMIT 1')
    .get(GATEWAY_KIND);
  if (row === undefined) return;
  throw new GatewayAccountError(db.$client.name, GatewayRow.parse(row));
}
