import {
  ConflictError,
  EventType,
  mintId,
  ModelProfilePatch,
  NotFoundError,
  ProfileSource,
  type Effort,
  type ModelProfileDto,
  type ModelProfileId,
  type ProfileScores,
  type Provider,
} from '@10db/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export interface NewModelProfile {
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly aaSlug: string | null;
  readonly enabled: boolean;
}

export interface AaMeasurement {
  readonly scores: ProfileScores;
  readonly costPerTaskUsd: number | null;
  readonly outputTokensPerSecond: number | null;
  readonly indexVersion: string | null;
  readonly measuredAt: string;
}

type Row = typeof schema.modelProfiles.$inferSelect;
const toDto = ({ intelligence, coding, agentic, ...rest }: Row): ModelProfileDto => ({
  ...rest,
  scores: { intelligence, coding, agentic },
});

export function insertModelProfile(ctx: WriteContext, input: NewModelProfile): ModelProfileDto {
  if (findModelProfile(ctx.tx, input.provider, input.model, input.effort))
    throw new ConflictError(`${input.model}@${input.effort} is already in the catalogue`);
  const row: Row = {
    id: mintId('ModelProfile'),
    ...input,
    intelligence: null,
    coding: null,
    agentic: null,
    costPerTaskUsd: null,
    outputTokensPerSecond: null,
    source: ProfileSource.Aa,
    indexVersion: null,
    measuredAt: null,
    stepsRun: 0,
    firstPassSteps: 0,
    escalations: 0,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.modelProfiles).values(row).run();
  ctx.emit({ type: EventType.ModelProfileSaved, entityType: 'model_profile', entityId: row.id });
  return toDto(row);
}

export function findModelProfile(
  db: DbReader,
  provider: Provider,
  model: string,
  effort: Effort,
): ModelProfileDto | undefined {
  const row = db
    .select()
    .from(schema.modelProfiles)
    .where(
      and(
        eq(schema.modelProfiles.provider, provider),
        eq(schema.modelProfiles.model, model),
        eq(schema.modelProfiles.effort, effort),
      ),
    )
    .get();
  return row ? toDto(row) : undefined;
}

export function getModelProfile(db: DbReader, id: ModelProfileId): ModelProfileDto {
  const row = db.select().from(schema.modelProfiles).where(eq(schema.modelProfiles.id, id)).get();
  if (!row) throw new NotFoundError('model profile', id);
  return toDto(row);
}

export function listModelProfiles(db: DbReader): ModelProfileDto[] {
  return db
    .select()
    .from(schema.modelProfiles)
    .orderBy(asc(schema.modelProfiles.model), asc(schema.modelProfiles.effort))
    .all()
    .map(toDto);
}

/** Hand-edited scores or cost make the profile `manual`, so the sync leaves it alone, unless the patch names its source. */
export function patchModelProfile(
  ctx: WriteContext,
  id: ModelProfileId,
  patch: ModelProfilePatch,
): ModelProfileDto {
  const { scores, ...changes } = ModelProfilePatch.parse(patch);
  getModelProfile(ctx.tx, id);
  const handEdited = scores !== undefined || changes.costPerTaskUsd !== undefined;
  ctx.tx
    .update(schema.modelProfiles)
    .set({
      ...changes,
      ...(scores ?? {}),
      ...(handEdited && changes.source === undefined ? { source: ProfileSource.Manual } : {}),
      updatedAt: ctx.now,
    })
    .where(eq(schema.modelProfiles.id, id))
    .run();
  ctx.emit({ type: EventType.ModelProfileSaved, entityType: 'model_profile', entityId: id });
  return getModelProfile(ctx.tx, id);
}

/** Writes an AA measurement onto a profile the sync owns; a manual profile is left alone. */
export function applyAaMeasurement(
  ctx: WriteContext,
  id: ModelProfileId,
  m: AaMeasurement,
): boolean {
  const result = ctx.tx
    .update(schema.modelProfiles)
    .set({
      ...m.scores,
      costPerTaskUsd: m.costPerTaskUsd,
      outputTokensPerSecond: m.outputTokensPerSecond,
      indexVersion: m.indexVersion,
      measuredAt: m.measuredAt,
      updatedAt: ctx.now,
    })
    .where(and(eq(schema.modelProfiles.id, id), eq(schema.modelProfiles.source, ProfileSource.Aa)))
    .run();
  return result.changes > 0;
}

/** Observed stats for the frontier (spec §4): one call per finished or escalated step. No event: counters only. */
export function recordProfileOutcome(
  ctx: WriteContext,
  id: ModelProfileId,
  outcome: { readonly firstPass: boolean; readonly escalated: boolean },
): void {
  ctx.tx
    .update(schema.modelProfiles)
    .set({
      stepsRun: sql`${schema.modelProfiles.stepsRun} + 1`,
      firstPassSteps: sql`${schema.modelProfiles.firstPassSteps} + ${outcome.firstPass ? 1 : 0}`,
      escalations: sql`${schema.modelProfiles.escalations} + ${outcome.escalated ? 1 : 0}`,
      updatedAt: ctx.now,
    })
    .where(eq(schema.modelProfiles.id, id))
    .run();
}
