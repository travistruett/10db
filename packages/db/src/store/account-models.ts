import {
  ConflictError,
  EventType,
  NotFoundError,
  type AccountId,
  type AccountModelDto,
  type Effort,
} from '@10db/contracts';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

/** A model an account reports; the store adds the account, the `unusable` mark and when it was seen. */
export type NewAccountModel = Pick<
  AccountModelDto,
  'model' | 'family' | 'launchId' | 'efforts' | 'inputPrice' | 'outputPrice'
>;

type Row = typeof schema.accountModels.$inferSelect;

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
 * Makes the account's list exactly `models`. A model the account still lists keeps `unusable` while
 * its launch id and efforts are unchanged; a price change alone does not clear it. An event is
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

/** Marks a model the account lists as one it refused to run, until a refresh shows it changed. */
export function markAccountModelUnusable(
  ctx: WriteContext,
  accountId: AccountId,
  model: string,
): void {
  const result = ctx.tx
    .update(schema.accountModels)
    .set({ unusable: true })
    .where(
      and(eq(schema.accountModels.accountId, accountId), eq(schema.accountModels.model, model)),
    )
    .run();
  if (result.changes === 0) throw new NotFoundError('account model', `${accountId}/${model}`);
  ctx.emit({ type: EventType.SettingsChanged, entityType: 'account_models', entityId: accountId });
}
