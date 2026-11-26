import {
  fitPrecedentExamples,
  mintId,
  PrecedentKind,
  PrecedentState,
  ProgramKey,
  type InboxItemId,
  type PrecedentScope,
  type ProjectId,
  type TrustPrecedentDto,
  type TrustPrecedentId,
} from '@10db/contracts';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { commandOfState } from './judge-calls';
import type { DbReader, WriteContext } from './store';

// A precedent is a standing approval of a kind of command that every judge weighs after the limits. This store
// only keeps the rows; nothing here clears a limit or writes a trust grant.

type PrecedentRow = typeof schema.trustPrecedents.$inferSelect;

function toDto(row: PrecedentRow): TrustPrecedentDto {
  return {
    id: row.id,
    projectId: row.projectId,
    programKey: row.programKey,
    scope: row.scope,
    kind: row.kind,
    examples: row.examples,
    runsHash: row.runsHash,
    state: row.state,
    uses: row.uses,
    lastUsedAt: row.lastUsedAt,
    conflicts: row.conflicts,
    sourceInboxId: row.sourceInboxId,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
  };
}

export interface PrecedentInput {
  readonly projectId: ProjectId;
  readonly programKey: string;
  readonly scope: PrecedentScope;
  readonly kind: string;
  readonly examples: readonly string[];
  readonly runsHash: string | null;
  readonly state: typeof PrecedentState.Active | typeof PrecedentState.Declined;
  readonly sourceInboxId: InboxItemId | null;
}

/**
 * Inserts the row, or moves the one the project, key and scope already have to `input.state` with its kind,
 * examples and hash; `active` sets conflicts to 0 and `approved_at` to now.
 *
 * The kind and key are parsed first, so a bad one throws and stores nothing. The examples are fitted
 * (`fitPrecedentExamples`) and never refused on: they are skip summaries passed as they are, in the same write as
 * Run these now, which a refusal would undo.
 */
export function approvePrecedent(ctx: WriteContext, input: PrecedentInput): TrustPrecedentDto {
  const kind = PrecedentKind.parse(input.kind);
  const programKey = ProgramKey.parse(input.programKey);
  const examples = fitPrecedentExamples(input.examples);
  const active = input.state === PrecedentState.Active;
  const row = ctx.tx
    .insert(schema.trustPrecedents)
    .values({
      id: mintId('TrustPrecedent'),
      projectId: input.projectId,
      programKey,
      scope: input.scope,
      kind,
      examples,
      runsHash: input.runsHash,
      state: input.state,
      uses: 0,
      lastUsedAt: null,
      conflicts: 0,
      sourceInboxId: input.sourceInboxId,
      approvedAt: active ? ctx.now : null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      endedAt: active ? null : ctx.now,
    })
    .onConflictDoUpdate({
      target: [
        schema.trustPrecedents.projectId,
        schema.trustPrecedents.programKey,
        schema.trustPrecedents.scope,
      ],
      set: {
        kind,
        examples,
        runsHash: input.runsHash,
        state: input.state,
        updatedAt: ctx.now,
        ...(active ? { conflicts: 0, endedAt: null, approvedAt: ctx.now } : { endedAt: ctx.now }),
        ...(input.sourceInboxId === null ? {} : { sourceInboxId: input.sourceInboxId }),
      },
    })
    .returning()
    .get();
  return toDto(row);
}

/** A project's precedents in every state, oldest first. */
export function listPrecedents(db: DbReader, projectId: ProjectId): TrustPrecedentDto[] {
  return db
    .select()
    .from(schema.trustPrecedents)
    .where(eq(schema.trustPrecedents.projectId, projectId))
    .orderBy(asc(schema.trustPrecedents.createdAt), asc(sql`trust_precedents.rowid`))
    .all()
    .map(toDto);
}

/**
 * Changes one of the project's precedents; null when the project has none by that id. `active` resets the
 * conflicts, sets `approved_at` to now and clears `ended_at`; `revoked` and `declined` set `ended_at`;
 * `paused` leaves it. Only `active` moves `approved_at`.
 */
export function setPrecedent(
  ctx: WriteContext,
  projectId: ProjectId,
  id: TrustPrecedentId,
  change: { state?: PrecedentState; kind?: string; runsHash?: string | null },
): TrustPrecedentDto | null {
  const kind = change.kind === undefined ? undefined : PrecedentKind.parse(change.kind);
  const ending = (state: PrecedentState) => {
    switch (state) {
      case PrecedentState.Active:
        return { conflicts: 0, endedAt: null, approvedAt: ctx.now };
      case PrecedentState.Revoked:
      case PrecedentState.Declined:
        return { endedAt: ctx.now };
      case PrecedentState.Paused:
        return {};
    }
  };
  const row = ctx.tx
    .update(schema.trustPrecedents)
    .set({
      updatedAt: ctx.now,
      ...(kind === undefined ? {} : { kind }),
      ...(change.runsHash === undefined ? {} : { runsHash: change.runsHash }),
      ...(change.state === undefined ? {} : { state: change.state, ...ending(change.state) }),
    })
    .where(and(eq(schema.trustPrecedents.id, id), eq(schema.trustPrecedents.projectId, projectId)))
    .returning()
    .all()[0];
  return row === undefined ? null : toDto(row);
}

/** Counts a call a precedent allowed. */
export function countPrecedentUse(ctx: WriteContext, id: TrustPrecedentId): void {
  ctx.tx
    .update(schema.trustPrecedents)
    .set({
      uses: sql`${schema.trustPrecedents.uses} + 1`,
      lastUsedAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(eq(schema.trustPrecedents.id, id))
    .run();
}

/** Counts a call of the kind a limit stopped, and answers the new count (0 when there is no such row). Never pauses. */
export function countPrecedentConflict(ctx: WriteContext, id: TrustPrecedentId): number {
  return (
    ctx.tx
      .update(schema.trustPrecedents)
      .set({ conflicts: sql`${schema.trustPrecedents.conflicts} + 1`, updatedAt: ctx.now })
      .where(eq(schema.trustPrecedents.id, id))
      .returning({ conflicts: schema.trustPrecedents.conflicts })
      .all()[0]?.conflicts ?? 0
  );
}

/** The calls a precedent allowed, newest first, up to `limit`; a row whose call can't be read is left out. */
export function lastAllowedByPrecedent(
  db: DbReader,
  id: TrustPrecedentId,
  limit: number,
): { call: string; at: string }[] {
  return db
    .select({ state: schema.judgeCalls.state, at: schema.judgeCalls.createdAt })
    .from(schema.judgeCalls)
    .where(eq(schema.judgeCalls.precedentId, id))
    .orderBy(desc(schema.judgeCalls.createdAt), desc(schema.judgeCalls.id))
    .limit(limit)
    .all()
    .flatMap((row) => {
      const call = commandOfState(row.state);
      return call === null ? [] : [{ call, at: row.at }];
    });
}
