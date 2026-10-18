import { AaModelDto, EventType } from '@10db/contracts';
import { asc, notInArray } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

/** Replaces the local copy of AA's list with this sync's, dropping models AA no longer lists. */
export function replaceAaModels(ctx: WriteContext, models: readonly AaModelDto[]): void {
  const slugs = models.map((m) => m.slug);
  ctx.tx
    .delete(schema.aaModels)
    .where(slugs.length > 0 ? notInArray(schema.aaModels.slug, slugs) : undefined)
    .run();
  for (const model of models)
    ctx.tx
      .insert(schema.aaModels)
      .values({ slug: model.slug, data: model, updatedAt: ctx.now })
      .onConflictDoUpdate({
        target: schema.aaModels.slug,
        set: { data: model, updatedAt: ctx.now },
      })
      .run();
  ctx.emit({
    type: EventType.BenchmarksSynced,
    entityType: 'benchmarks',
    entityId: 'aa',
    data: { models: models.length },
  });
}

/** Read back through the schema: the column holds JSON a later 10db may have widened. */
export function listAaModels(db: DbReader): AaModelDto[] {
  return db
    .select({ data: schema.aaModels.data })
    .from(schema.aaModels)
    .orderBy(asc(schema.aaModels.slug))
    .all()
    .map((r) => AaModelDto.parse(r.data));
}
