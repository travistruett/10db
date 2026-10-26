import {
  AccountId,
  AccountInput,
  AccountKind,
  AccountPatch,
  ConflictError,
  DEFAULT_ACCOUNT_LABEL,
  DEFAULT_ACCOUNT_LANE_CAP,
  EventType,
  InvalidError,
  isMetered,
  mintId,
  needsSecret,
  NotFoundError,
  parseAccountSettings,
  type AccountDto,
  type AccountSettings,
} from '@10db/contracts';
import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../schema';
import { getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';

export type AccountRow = typeof schema.accounts.$inferSelect;

/** The app setting naming the account new projects bind to when they name none. */
const DEFAULT_ACCOUNT_KEY = 'accounts.default';
const Email = z.email();

/** The Keychain account (service `10db`) that holds an account's secret. */
export function accountSecretRef(id: AccountId): string {
  return `account:${id}`;
}

export function defaultAccountId(db: DbReader): AccountId | null {
  const parsed = AccountId.safeParse(getAppSetting(db, DEFAULT_ACCOUNT_KEY));
  return parsed.success ? parsed.data : null;
}

function toDto(db: DbReader, row: AccountRow): AccountDto {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    payer: row.payer,
    expectedIdentity: row.expectedIdentity,
    configDir: row.configDir,
    // Stored JSON is parsed for its kind on the way out, so a drifted row fails loudly here.
    settings: parseAccountSettings(row.kind, row.settings),
    laneCap: row.laneCap,
    monthlyCapUsd: row.monthlyCapUsd,
    archived: row.archived,
    isDefault: defaultAccountId(db) === row.id,
    secretSet: row.secretFingerprint !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `fields` names what changed; a value never goes into the event log. */
function saved(ctx: WriteContext, id: AccountId, fields: readonly string[]): void {
  ctx.emit({
    type: EventType.AccountSaved,
    entityType: 'account',
    entityId: id,
    data: { fields: [...fields] },
  });
}

function refuseTakenLabel(db: DbReader, label: string, except: AccountId | null): void {
  const taken = db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      except
        ? and(eq(schema.accounts.label, label), ne(schema.accounts.id, except))
        : eq(schema.accounts.label, label),
    )
    .get();
  if (taken) throw new ConflictError(`An account is already called "${label}"`);
}

export function getAccountRow(db: DbReader, id: AccountId): AccountRow {
  const row = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!row) throw new NotFoundError('account', id);
  return row;
}

export function getAccount(db: DbReader, id: AccountId): AccountDto {
  return toDto(db, getAccountRow(db, id));
}

export function listAccounts(
  db: DbReader,
  opts: { readonly includeArchived?: boolean } = {},
): AccountDto[] {
  const rows = db.select().from(schema.accounts).orderBy(asc(schema.accounts.label)).all();
  return rows.filter((r) => opts.includeArchived === true || !r.archived).map((r) => toDto(db, r));
}

export function insertAccount(
  ctx: WriteContext,
  input: AccountInput,
  opts: { configDirFor(id: AccountId): string },
): AccountDto {
  const config = AccountInput.parse(input);
  refuseTakenLabel(ctx.tx, config.label, null);
  const id = mintId('Account');
  const row: AccountRow = {
    id,
    kind: config.kind,
    label: config.label,
    payer: config.payer,
    expectedIdentity: 'expectedIdentity' in config ? config.expectedIdentity : null,
    // Keyed kinds too: a session on the default account's directory would read its saved login and config.
    configDir: opts.configDirFor(id),
    secretRef: needsSecret(config.kind, config.settings) ? accountSecretRef(id) : null,
    secretFingerprint: null,
    settings: config.settings,
    laneCap: config.laneCap,
    monthlyCapUsd: 'monthlyCapUsd' in config ? config.monthlyCapUsd : null,
    archived: false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.accounts).values(row).run();
  saved(ctx, id, ['created']);
  return toDto(ctx.tx, row);
}

/** Settings checked against the account's own kind; a mismatch is the caller's mistake (400). */
function settingsFor(row: AccountRow, raw: unknown): AccountSettings {
  try {
    return parseAccountSettings(row.kind, raw);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new InvalidError(
        `Those settings don't fit a ${row.kind} account: ${error.issues.map((i) => i.message).join('; ')}`,
      );
    throw error;
  }
}

export function patchAccount(ctx: WriteContext, id: AccountId, patch: AccountPatch): AccountDto {
  const changes = AccountPatch.parse(patch);
  const row = getAccountRow(ctx.tx, id);
  if (row.archived) throw new ConflictError(`Account "${row.label}" is archived`);
  if (changes.label !== undefined) refuseTakenLabel(ctx.tx, changes.label, id);
  if (typeof changes.monthlyCapUsd === 'number' && !isMetered(row.kind))
    throw new InvalidError('Only API-key, Bedrock and gateway accounts take a monthly dollar cap');
  if (typeof changes.expectedIdentity === 'string') {
    if (row.kind === AccountKind.Gateway)
      throw new InvalidError(
        'A gateway account is identified by its key, not an expected identity',
      );
    if (
      row.kind === AccountKind.ClaudeSubscription &&
      !Email.safeParse(changes.expectedIdentity).success
    )
      throw new InvalidError("A subscription's expected identity is the email it signs in as");
  }
  const settings = changes.settings === undefined ? undefined : settingsFor(row, changes.settings);
  // A Bedrock account moving between a profile and a bearer token gains or loses its secret.
  const secretRef =
    settings === undefined
      ? row.secretRef
      : needsSecret(row.kind, settings)
        ? accountSecretRef(id)
        : null;
  ctx.tx
    .update(schema.accounts)
    .set({
      ...(changes.label !== undefined ? { label: changes.label } : {}),
      ...(changes.payer !== undefined ? { payer: changes.payer } : {}),
      ...(changes.laneCap !== undefined ? { laneCap: changes.laneCap } : {}),
      ...(changes.monthlyCapUsd !== undefined ? { monthlyCapUsd: changes.monthlyCapUsd } : {}),
      ...(changes.expectedIdentity !== undefined
        ? { expectedIdentity: changes.expectedIdentity }
        : {}),
      ...(settings !== undefined
        ? {
            settings,
            secretRef,
            secretFingerprint: secretRef === null ? null : row.secretFingerprint,
          }
        : {}),
      updatedAt: ctx.now,
    })
    .where(eq(schema.accounts.id, id))
    .run();
  saved(ctx, id, Object.keys(changes).sort());
  return getAccount(ctx.tx, id);
}

/** Archiving is refused while a project binds the account, and for the default account. */
export function archiveAccount(ctx: WriteContext, id: AccountId): AccountDto {
  const row = getAccountRow(ctx.tx, id);
  if (row.archived) return getAccount(ctx.tx, id);
  if (defaultAccountId(ctx.tx) === id)
    throw new ConflictError(
      `"${row.label}" is the default account for new projects, so it can't be archived`,
    );
  const bound = ctx.tx
    .select({ name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.accountId, id))
    .all();
  if (bound.length > 0)
    throw new ConflictError(
      `Move ${bound.map((p) => `"${p.name}"`).join(', ')} to another account before archiving "${row.label}"`,
    );
  const fallbackFor = ctx.tx
    .select({ name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.fallbackAccountId, id))
    .all();
  if (fallbackFor.length > 0)
    throw new ConflictError(
      `Clear "${row.label}" as the fallback of ${fallbackFor.map((p) => `"${p.name}"`).join(', ')} before archiving it`,
    );
  ctx.tx
    .update(schema.accounts)
    .set({ archived: true, updatedAt: ctx.now })
    .where(eq(schema.accounts.id, id))
    .run();
  saved(ctx, id, ['archived']);
  return getAccount(ctx.tx, id);
}

/** Records the fingerprint of the secret just stored in the Keychain; the secret itself is never passed here. */
export function recordAccountSecret(
  ctx: WriteContext,
  id: AccountId,
  fingerprint: string,
): AccountDto {
  const row = getAccountRow(ctx.tx, id);
  if (row.archived) throw new ConflictError(`Account "${row.label}" is archived`);
  if (row.secretRef === null) throw new InvalidError(`Account "${row.label}" takes no secret`);
  ctx.tx
    .update(schema.accounts)
    .set({ secretFingerprint: fingerprint, updatedAt: ctx.now })
    .where(eq(schema.accounts.id, id))
    .run();
  saved(ctx, id, ['secret']);
  return getAccount(ctx.tx, id);
}

/**
 * On a database with no default account: the builder's current login as "Claude plan", the default for
 * new projects (accounts spec §3 "accounts start fresh"). `configDir` is where that login lives: the
 * login shell's own Claude Code directory, or null for Claude Code's default.
 */
export function seedDefaultAccount(
  ctx: WriteContext,
  opts: { readonly expectedIdentity: string | null; readonly configDir?: string | null },
): AccountDto | null {
  if (defaultAccountId(ctx.tx) !== null) return null;
  const row: AccountRow = {
    id: mintId('Account'),
    kind: AccountKind.ClaudeSubscription,
    label: DEFAULT_ACCOUNT_LABEL,
    payer: '',
    expectedIdentity: opts.expectedIdentity,
    configDir: opts.configDir ?? null,
    secretRef: null,
    secretFingerprint: null,
    settings: {},
    laneCap: DEFAULT_ACCOUNT_LANE_CAP,
    monthlyCapUsd: null,
    archived: false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.accounts).values(row).run();
  setAppSetting(ctx, DEFAULT_ACCOUNT_KEY, row.id);
  saved(ctx, row.id, ['created']);
  return toDto(ctx.tx, row);
}
