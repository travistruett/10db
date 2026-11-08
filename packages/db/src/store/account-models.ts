import {
  ConflictError,
  EventType,
  ModelMarkBasis,
  NotFoundError,
  type AccountId,
  type AccountModelDto,
  type Effort,
} from '@10db/contracts';
import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

/** A model an account reports; the store adds the account, the `unusable` mark and when it was seen. */
export type NewAccountModel = Pick<
  AccountModelDto,
  'model' | 'family' | 'launchId' | 'efforts' | 'inputPrice' | 'outputPrice'
>;

type Row = typeof schema.accountModels.$inferSelect;

/** How long a mark from an error's wording alone keeps the model out of routing before one session may test it. */
export const WORDING_MARK_MS = 60 * 60_000;

const toDto = (row: Row): AccountModelDto => row;

const sameEfforts = (a: readonly Effort[], b: readonly Effort[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** What the CLI is launched with: the launch id and the efforts, which decide whether a refusal still holds. */
const sameOffer = (a: NewAccountModel, b: NewAccountModel) =>
  a.launchId === b.launchId && sameEfforts(a.efforts, b.efforts);

const samePricing = (a: NewAccountModel, b: NewAccountModel) =>
  a.inputPrice === b.inputPrice && a.outputPrice === b.outputPrice;

export function listAccountModels(db: DbReader, accountId?: AccountId): AccountModelDto[] {
  return db
    .select()
    .from(schema.accountModels)
    .where(accountId === undefined ? undefined : eq(schema.accountModels.accountId, accountId))
    .orderBy(asc(schema.accountModels.accountId), asc(schema.accountModels.model))
    .all()
    .map(toDto);
}

/**
 * Makes the account's list exactly `models`. A model the account still lists keeps `unusable` (and the end of a
 * mark from wording) while its launch id and efforts are unchanged; a price change alone does not clear it. An event is
 * appended only when the list differs from what was stored, so a refresh that finds nothing new is quiet.
 * Answers whether the list changed. A model named twice is refused with a `ConflictError`.
 */
export function replaceAccountModels(
  ctx: WriteContext,
  accountId: AccountId,
  models: readonly NewAccountModel[],
): boolean {
  const names = new Set<string>();
  for (const { model } of models) {
    if (names.has(model)) throw new ConflictError(`${model} is listed twice for ${accountId}`);
    names.add(model);
  }
  const before = new Map(listAccountModels(ctx.tx, accountId).map((m) => [m.model, m]));
  const rows: Row[] = models.map((m) => {
    const previous = before.get(m.model);
    const keepsMark = previous ? sameOffer(previous, m) : false;
    return {
      ...m,
      accountId,
      unusable: keepsMark && previous?.unusable === true,
      wordingMarkEndsAt: keepsMark ? (previous?.wordingMarkEndsAt ?? null) : null,
      lastSeenAt: ctx.now,
    };
  });
  const changed =
    rows.length !== before.size ||
    rows.some((row) => {
      const previous = before.get(row.model);
      return (
        !previous ||
        !sameOffer(previous, row) ||
        !samePricing(previous, row) ||
        previous.unusable !== row.unusable ||
        previous.wordingMarkEndsAt !== row.wordingMarkEndsAt ||
        previous.family !== row.family
      );
    });
  ctx.tx.delete(schema.accountModels).where(eq(schema.accountModels.accountId, accountId)).run();
  if (rows.length > 0) ctx.tx.insert(schema.accountModels).values(rows).run();
  if (changed) {
    ctx.emit({
      type: EventType.SettingsChanged,
      entityType: 'account_models',
      entityId: accountId,
    });
  }
  return changed;
}

const rowOf = (accountId: AccountId, model: string) =>
  and(eq(schema.accountModels.accountId, accountId), eq(schema.accountModels.model, model));

/** What a mark stands at after a refusal: when it ends (null: final), and whether a second refusal made it final. */
export interface MarkResult {
  readonly endsAt: string | null;
  readonly confirmed: boolean;
}

/** Where a row's mark stands after a refusal from wording alone, by the mark it had. */
function afterWordingRefusal(row: Row, now: string): MarkResult {
  const endsAt = row.wordingMarkEndsAt;
  // Final: from model_not_found, or confirmed already.
  if (row.unusable && endsAt === null) return { endsAt: null, confirmed: true };
  // In force: another session was refused the same way meanwhile; the first mark stands.
  if (row.unusable && endsAt !== null && Date.parse(endsAt) > Date.parse(now))
    return { endsAt, confirmed: false };
  // Ended: the model was tried again after its mark and refused the same way.
  if (endsAt !== null) return { endsAt: null, confirmed: true };
  return { endsAt: new Date(Date.parse(now) + WORDING_MARK_MS).toISOString(), confirmed: false };
}

/**
 * Marks a model the account lists as one it refused to run. A mark from `error` (Claude Code's `model_not_found`)
 * lasts until a refresh shows the offer changed. One from `wording` alone ends after `WORDING_MARK_MS`, and a
 * refusal after it ended makes it final: the model was tried again and refused the same way. A refusal while a mark
 * from wording is in force changes nothing; one from `error` always makes it final; a final mark stays final.
 */
export function markAccountModelUnusable(
  ctx: WriteContext,
  accountId: AccountId,
  model: string,
  basis: ModelMarkBasis = ModelMarkBasis.Error,
): MarkResult {
  const current = ctx.tx.select().from(schema.accountModels).where(rowOf(accountId, model)).get();
  if (!current) throw new NotFoundError('account model', `${accountId}/${model}`);
  const final: MarkResult = { endsAt: null, confirmed: true };
  const result = basis === ModelMarkBasis.Wording ? afterWordingRefusal(current, ctx.now) : final;
  ctx.tx
    .update(schema.accountModels)
    .set({ unusable: true, wordingMarkEndsAt: result.endsAt })
    .where(rowOf(accountId, model))
    .run();
  ctx.emit({ type: EventType.SettingsChanged, entityType: 'account_models', entityId: accountId });
  return result;
}

/**
 * Ends every mark from wording whose time has come: the model is routed to again (`unusable` false), and the mark
 * stays on record (`wordingMarkEndsAt`) until a session on the model clears it or a refusal makes it final.
 * Answers the end of the next mark still to come, or null when none is.
 */
export function endWordingMarks(ctx: WriteContext): string | null {
  const ended = ctx.tx
    .update(schema.accountModels)
    .set({ unusable: false })
    .where(
      and(
        eq(schema.accountModels.unusable, true),
        isNotNull(schema.accountModels.wordingMarkEndsAt),
        lte(schema.accountModels.wordingMarkEndsAt, ctx.now),
      ),
    )
    .returning({ accountId: schema.accountModels.accountId })
    .all();
  for (const accountId of new Set(ended.map((e) => e.accountId)))
    ctx.emit({
      type: EventType.SettingsChanged,
      entityType: 'account_models',
      entityId: accountId,
    });
  const next = ctx.tx
    .select({ endsAt: schema.accountModels.wordingMarkEndsAt })
    .from(schema.accountModels)
    .where(
      and(
        eq(schema.accountModels.unusable, true),
        isNotNull(schema.accountModels.wordingMarkEndsAt),
      ),
    )
    .orderBy(asc(schema.accountModels.wordingMarkEndsAt))
    .limit(1)
    .get();
  return next?.endsAt ?? null;
}

/**
 * A session ran on the model without being refused, so a mark from wording was wrong: it is cleared. A final mark
 * is left alone. Answers whether a mark was cleared.
 */
export function clearWordingMark(ctx: WriteContext, accountId: AccountId, model: string): boolean {
  const result = ctx.tx
    .update(schema.accountModels)
    .set({ unusable: false, wordingMarkEndsAt: null })
    .where(and(rowOf(accountId, model), isNotNull(schema.accountModels.wordingMarkEndsAt)))
    .run();
  if (result.changes === 0) return false;
  ctx.emit({ type: EventType.SettingsChanged, entityType: 'account_models', entityId: accountId });
  return true;
}
