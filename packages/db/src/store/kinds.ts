import {
  ConflictError,
  EventType,
  InvalidError,
  KindInput,
  KindPatch,
  mintId,
  NotFoundError,
  effectiveRigor,
  type KindDto,
  type KindId,
  type Rigor,
  type TaskKind,
} from '@10db/contracts';
import { asc, eq, max } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

type KindRow = typeof schema.kinds.$inferSelect;

const toKindDto = (row: KindRow): KindDto => ({
  id: row.id,
  key: row.key,
  label: row.label,
  description: row.description,
  minimumRigor: row.minimumRigor,
  alwaysReviewed: row.alwaysReviewed,
  failsAtLimit: row.failsAtLimit,
  ownCopy: row.ownCopy,
  toInbox: row.toInbox,
  addsSteps: row.addsSteps,
  overrides: row.overrides,
  position: row.position,
});

function kindChanged(ctx: WriteContext, id: KindId): void {
  ctx.emit({ type: EventType.SettingsChanged, entityType: 'kind', entityId: id });
}

/** Every kind, in the builder's order. */
export function listKinds(db: DbReader): KindDto[] {
  return db
    .select()
    .from(schema.kinds)
    .orderBy(asc(schema.kinds.position), asc(schema.kinds.id))
    .all()
    .map(toKindDto);
}

export function getKind(db: DbReader, id: KindId): KindDto {
  const row = db.select().from(schema.kinds).where(eq(schema.kinds.id, id)).get();
  if (!row) throw new NotFoundError('kind', id);
  return toKindDto(row);
}

/** Adds a kind at the end of the list; a key another kind has is refused. */
export function insertKind(ctx: WriteContext, input: KindInput): KindDto {
  const config = KindInput.parse(input);
  const taken = ctx.tx
    .select({ id: schema.kinds.id })
    .from(schema.kinds)
    .where(eq(schema.kinds.key, config.key))
    .get();
  if (taken) throw new ConflictError(`A kind with the key "${config.key}" already exists`);
  const last = ctx.tx
    .select({ value: max(schema.kinds.position) })
    .from(schema.kinds)
    .get();
  const row: KindRow = {
    id: mintId('Kind'),
    ...config,
    position: (last?.value ?? -1) + 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.kinds).values(row).run();
  kindChanged(ctx, row.id);
  return toKindDto(row);
}

/** Changes the fields a patch names; the key is never one of them. */
export function patchKind(ctx: WriteContext, id: KindId, patch: KindPatch): KindDto {
  const changes = KindPatch.parse(patch);
  getKind(ctx.tx, id);
  ctx.tx
    .update(schema.kinds)
    .set({ ...changes, updatedAt: ctx.now })
    .where(eq(schema.kinds.id, id))
    .run();
  kindChanged(ctx, id);
  return getKind(ctx.tx, id);
}

/** Removes a kind. Tasks that name its key keep the name, which then means nothing. */
export function deleteKind(ctx: WriteContext, id: KindId): void {
  getKind(ctx.tx, id);
  ctx.tx.delete(schema.kinds).where(eq(schema.kinds.id, id)).run();
  kindChanged(ctx, id);
}

/** Puts a kind at a place in the list (0 is first; past the end is last) and numbers the rest again. */
export function moveKind(ctx: WriteContext, id: KindId, position: number): KindDto[] {
  const ids = listKinds(ctx.tx).map((k) => k.id);
  if (!ids.includes(id)) throw new NotFoundError('kind', id);
  const rest = ids.filter((other) => other !== id);
  rest.splice(Math.min(Math.max(position, 0), rest.length), 0, id);
  rest.forEach((kindId, index) => {
    ctx.tx
      .update(schema.kinds)
      .set({ position: index, updatedAt: ctx.now })
      .where(eq(schema.kinds.id, kindId))
      .run();
  });
  kindChanged(ctx, id);
  return listKinds(ctx.tx);
}

/** Refuses a task kind whose key no kind has, and keeps the first of a key given twice. */
export function checkTaskKinds(db: DbReader, kinds: readonly TaskKind[]): TaskKind[] {
  const known = new Set(listKinds(db).map((k) => k.key));
  const unknown = kinds.filter((k) => !known.has(k.key)).map((k) => k.key);
  if (unknown.length > 0) throw new InvalidError(`Unknown kinds: ${unknown.join(', ')}`);
  return kinds.filter((k, i) => kinds.findIndex((other) => other.key === k.key) === i);
}

/** The rigor a task runs at (`effectiveRigor`), reading the kinds from the database. */
export function effectiveRigorOf(
  db: DbReader,
  projectDefault: Rigor,
  rigor: Rigor | null,
  taskKinds: readonly TaskKind[],
): Rigor {
  return effectiveRigor({ rigor, projectDefault, taskKinds, kinds: listKinds(db) });
}
