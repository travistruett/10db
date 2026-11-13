import {
  EventType,
  mintId,
  PlanAnchor,
  PlanEntryBody,
  SectionIndexEntry,
  type PlanEntryKind,
  type PlanEntryState,
  type ShapeAttachmentId,
  type ShapeEntryId,
  type ShapeId,
} from '@10db/contracts';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Json } from '../json';
import * as schema from '../schema';
import type { ShapeAttachmentRow } from './shape-review';
import { getShape } from './shapes';
import type { DbReader, WriteContext } from './store';

// A Plan's record: its documents' revisions and its entries with their versions. A revision's text
// and an entry's version never change once written; a new text or content is the next number.

export type AttachmentRevisionRow = typeof schema.shapeAttachmentRevisions.$inferSelect;
type EntryRow = typeof schema.shapeEntries.$inferSelect;
export type ShapeEntryVersionRow = typeof schema.shapeEntryVersions.$inferSelect;

/** The kinds of attachment that are record documents; an eval is one too, listed with them. */
export const DOCUMENT_KINDS = ['research', 'spec', 'plan', 'guide'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const Sections = z.array(SectionIndexEntry);
const Anchors = z.array(PlanAnchor);
const Sources = z.array(z.string());

const tell = (ctx: WriteContext, shapeId: ShapeId, what: string): void => {
  ctx.emit({
    type: EventType.PlanRecordChanged,
    entityType: 'shape',
    entityId: shapeId,
    data: { projectId: getShape(ctx.tx, shapeId).projectId, what },
  });
};

// --- Documents ----------------------------------------------------------------------------------

/** A stored revision, its sections parsed (the column is JSON). */
const revisionOf = (row: AttachmentRevisionRow): AttachmentRevisionRow => ({
  ...row,
  sections: Sections.parse(row.sections),
});

function attachmentById(db: DbReader, id: ShapeAttachmentId): ShapeAttachmentRow | undefined {
  return db.select().from(schema.shapeAttachments).where(eq(schema.shapeAttachments.id, id)).get();
}

/** An attachment by its id: a document, an app spec or an eval. */
export function getDocumentAttachment(
  db: DbReader,
  id: ShapeAttachmentId,
): ShapeAttachmentRow | undefined {
  return attachmentById(db, id);
}

function latestRevision(
  db: DbReader,
  attachmentId: ShapeAttachmentId,
): AttachmentRevisionRow | undefined {
  const row = db
    .select()
    .from(schema.shapeAttachmentRevisions)
    .where(eq(schema.shapeAttachmentRevisions.attachmentId, attachmentId))
    .orderBy(desc(schema.shapeAttachmentRevisions.number))
    .get();
  return row ? revisionOf(row) : undefined;
}

/**
 * Appends a revision: the latest number plus one, and the attachment's body follows it. With no
 * bundle number, a body whose hash is the latest's writes nothing and answers the latest.
 */
export function insertAttachmentRevision(
  ctx: WriteContext,
  input: {
    readonly attachmentId: ShapeAttachmentId;
    readonly body: string;
    readonly sha256: string;
    readonly sections: readonly SectionIndexEntry[];
    readonly note: string | null;
    readonly author: string | null;
    readonly bundleNumber: number | null;
    readonly authoredAt: string | null;
  },
): { row: AttachmentRevisionRow; created: boolean } {
  const attachment = attachmentById(ctx.tx, input.attachmentId);
  if (!attachment) throw new Error(`No attachment ${input.attachmentId}`);
  const latest = latestRevision(ctx.tx, input.attachmentId);
  if (latest && input.bundleNumber === null && latest.sha256 === input.sha256)
    return { row: latest, created: false };
  const row: AttachmentRevisionRow = {
    id: mintId('ShapeAttachmentRevision'),
    attachmentId: input.attachmentId,
    number: (latest?.number ?? 0) + 1,
    body: input.body,
    sha256: input.sha256,
    note: input.note,
    author: input.author,
    sections: [...input.sections],
    bundleNumber: input.bundleNumber,
    authoredAt: input.authoredAt,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.shapeAttachmentRevisions).values(row).run();
  ctx.tx
    .update(schema.shapeAttachments)
    .set({ body: input.body, updatedAt: ctx.now })
    .where(eq(schema.shapeAttachments.id, input.attachmentId))
    .run();
  tell(ctx, attachment.shapeId, 'documents');
  return { row, created: true };
}

/** A document's revisions, oldest first. */
export function listAttachmentRevisions(
  db: DbReader,
  attachmentId: ShapeAttachmentId,
): AttachmentRevisionRow[] {
  return db
    .select()
    .from(schema.shapeAttachmentRevisions)
    .where(eq(schema.shapeAttachmentRevisions.attachmentId, attachmentId))
    .orderBy(asc(schema.shapeAttachmentRevisions.number))
    .all()
    .map(revisionOf);
}

export function getAttachmentRevision(
  db: DbReader,
  attachmentId: ShapeAttachmentId,
  number: number,
): AttachmentRevisionRow | undefined {
  const row = db
    .select()
    .from(schema.shapeAttachmentRevisions)
    .where(
      and(
        eq(schema.shapeAttachmentRevisions.attachmentId, attachmentId),
        eq(schema.shapeAttachmentRevisions.number, number),
      ),
    )
    .get();
  return row ? revisionOf(row) : undefined;
}

export function getAttachmentRevisionById(
  db: DbReader,
  id: AttachmentRevisionRow['id'],
): AttachmentRevisionRow | undefined {
  const row = db
    .select()
    .from(schema.shapeAttachmentRevisions)
    .where(eq(schema.shapeAttachmentRevisions.id, id))
    .get();
  return row ? revisionOf(row) : undefined;
}

/**
 * A Plan's document by its key: the attachment whose `doc_key` it is, else an app spec (first) or
 * eval with no `doc_key` whose `key` it is.
 */
export function findDocument(
  db: DbReader,
  shapeId: ShapeId,
  docKey: string,
): ShapeAttachmentRow | undefined {
  const imported = db
    .select()
    .from(schema.shapeAttachments)
    .where(
      and(eq(schema.shapeAttachments.shapeId, shapeId), eq(schema.shapeAttachments.docKey, docKey)),
    )
    .get();
  if (imported) return imported;
  const app = db
    .select()
    .from(schema.shapeAttachments)
    .where(
      and(
        eq(schema.shapeAttachments.shapeId, shapeId),
        eq(schema.shapeAttachments.key, docKey),
        isNull(schema.shapeAttachments.docKey),
        inArray(schema.shapeAttachments.kind, ['spec', 'eval']),
      ),
    )
    .all();
  return app.find((row) => row.kind === 'spec') ?? app[0];
}

/** Every attachment of the given kinds, across all Plans, oldest first. */
export function listAttachmentsOfKinds(
  db: DbReader,
  kinds: readonly ShapeAttachmentRow['kind'][],
): ShapeAttachmentRow[] {
  return db
    .select()
    .from(schema.shapeAttachments)
    .where(inArray(schema.shapeAttachments.kind, [...kinds]))
    .orderBy(asc(schema.shapeAttachments.id))
    .all();
}

/** A Plan's documents and evals, oldest first, each with its document key. */
export function listDocuments(
  db: DbReader,
  shapeId: ShapeId,
): (ShapeAttachmentRow & { readonly documentKey: string })[] {
  return db
    .select()
    .from(schema.shapeAttachments)
    .where(
      and(
        eq(schema.shapeAttachments.shapeId, shapeId),
        inArray(schema.shapeAttachments.kind, [...DOCUMENT_KINDS, 'eval']),
      ),
    )
    .orderBy(asc(schema.shapeAttachments.id))
    .all()
    .map((row) => ({ ...row, documentKey: row.docKey ?? row.key }));
}

/** Writes a record document's attachment; its text arrives by `insertAttachmentRevision`. */
export function insertDocumentAttachment(
  ctx: WriteContext,
  input: {
    readonly shapeId: ShapeId;
    readonly kind: DocumentKind;
    readonly key: string;
    readonly docKey: string;
    readonly title: string;
    readonly body: string;
  },
): ShapeAttachmentRow {
  const row: ShapeAttachmentRow = {
    id: mintId('ShapeAttachment'),
    ...input,
    goalId: null,
    taskId: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.shapeAttachments).values(row).run();
  tell(ctx, input.shapeId, 'documents');
  return row;
}

// --- Entries ------------------------------------------------------------------------------------

type EntryBody = PlanEntryBody[PlanEntryKind];

/** An entry as it reads: its JSON parsed and its current version number. */
export interface ShapeEntryRow extends Omit<EntryRow, 'body' | 'anchors' | 'sources'> {
  readonly body: EntryBody;
  readonly anchors: PlanAnchor[];
  readonly sources: string[];
  readonly version: number;
}

export interface NewShapeEntry {
  readonly shapeId: ShapeId;
  readonly key: string;
  readonly kind: PlanEntryKind;
  readonly title: string;
  readonly body: EntryBody;
  readonly anchors: readonly PlanAnchor[];
  readonly sources: readonly string[];
  readonly verified: boolean;
  readonly checkedAt: string | null;
  readonly state: PlanEntryState;
}

/** JSON with every object's keys sorted, so two equal contents compare equal as text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, canonical(inner)]),
  );
}

/** The content a version snapshots: everything but the ids and timestamps. */
const contentOf = (e: {
  readonly kind: PlanEntryKind;
  readonly title: string;
  readonly body: unknown;
  readonly anchors: readonly unknown[];
  readonly sources: readonly string[];
  readonly verified: boolean;
  readonly checkedAt: string | null;
  readonly state: PlanEntryState;
}): Json =>
  // canonical() answers plain JSON values built from JSON input, so the cast names what it is.
  canonical({
    kind: e.kind,
    title: e.title,
    body: e.body,
    anchors: e.anchors,
    sources: e.sources,
    verified: e.verified,
    checkedAt: e.checkedAt,
    state: e.state,
  }) as Json;

function entryOf(row: EntryRow, version: number): ShapeEntryRow {
  return {
    ...row,
    body: PlanEntryBody[row.kind].parse(row.body),
    anchors: Anchors.parse(row.anchors),
    sources: Sources.parse(row.sources),
    version,
  };
}

function versionsOf(db: DbReader, entryIds: readonly ShapeEntryId[]): Map<ShapeEntryId, number> {
  const out = new Map<ShapeEntryId, number>();
  if (entryIds.length === 0) return out;
  for (const v of db
    .select({
      entryId: schema.shapeEntryVersions.entryId,
      number: schema.shapeEntryVersions.number,
    })
    .from(schema.shapeEntryVersions)
    .where(inArray(schema.shapeEntryVersions.entryId, [...entryIds]))
    .all())
    out.set(v.entryId, Math.max(out.get(v.entryId) ?? 0, v.number));
  return out;
}

/**
 * Saves an entry by its key within its Plan. A new key is version 1; content that differs from the
 * stored content updates the row and appends the next version; equal content writes nothing.
 */
export function upsertShapeEntry(
  ctx: WriteContext,
  input: NewShapeEntry,
): { row: ShapeEntryRow; version: number; changed: boolean } {
  const held = ctx.tx
    .select()
    .from(schema.shapeEntries)
    .where(
      and(eq(schema.shapeEntries.shapeId, input.shapeId), eq(schema.shapeEntries.key, input.key)),
    )
    .get();
  const content = contentOf(input);
  const columns = {
    kind: input.kind,
    title: input.title,
    // The body was parsed by its kind's schema, so it is JSON.
    body: input.body as Json,
    anchors: [...input.anchors],
    sources: [...input.sources],
    verified: input.verified,
    checkedAt: input.checkedAt,
    state: input.state,
  };
  if (held) {
    const version = versionsOf(ctx.tx, [held.id]).get(held.id) ?? 1;
    if (JSON.stringify(contentOf(held)) === JSON.stringify(content))
      return { row: entryOf(held, version), version, changed: false };
    ctx.tx
      .update(schema.shapeEntries)
      .set({ ...columns, updatedAt: ctx.now })
      .where(eq(schema.shapeEntries.id, held.id))
      .run();
    ctx.tx
      .insert(schema.shapeEntryVersions)
      .values({
        id: mintId('ShapeEntryVersion'),
        entryId: held.id,
        number: version + 1,
        snapshot: content,
        createdAt: ctx.now,
      })
      .run();
    tell(ctx, input.shapeId, 'entries');
    const row = entryOf({ ...held, ...columns, updatedAt: ctx.now }, version + 1);
    return { row, version: version + 1, changed: true };
  }
  const row: EntryRow = {
    id: mintId('ShapeEntry'),
    shapeId: input.shapeId,
    key: input.key,
    ...columns,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.shapeEntries).values(row).run();
  ctx.tx
    .insert(schema.shapeEntryVersions)
    .values({
      id: mintId('ShapeEntryVersion'),
      entryId: row.id,
      number: 1,
      snapshot: content,
      createdAt: ctx.now,
    })
    .run();
  tell(ctx, input.shapeId, 'entries');
  return { row: entryOf(row, 1), version: 1, changed: true };
}

/** A Plan's entries, oldest first, superseded ones included. */
export function listShapeEntries(db: DbReader, shapeId: ShapeId): ShapeEntryRow[] {
  const rows = db
    .select()
    .from(schema.shapeEntries)
    .where(eq(schema.shapeEntries.shapeId, shapeId))
    .orderBy(asc(schema.shapeEntries.id))
    .all();
  const versions = versionsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => entryOf(r, versions.get(r.id) ?? 1));
}

export function getShapeEntry(
  db: DbReader,
  shapeId: ShapeId,
  key: string,
): ShapeEntryRow | undefined {
  const row = db
    .select()
    .from(schema.shapeEntries)
    .where(and(eq(schema.shapeEntries.shapeId, shapeId), eq(schema.shapeEntries.key, key)))
    .get();
  return row ? entryOf(row, versionsOf(db, [row.id]).get(row.id) ?? 1) : undefined;
}

export function getShapeEntryVersion(
  db: DbReader,
  entryId: ShapeEntryId,
  number: number,
): ShapeEntryVersionRow | undefined {
  return db
    .select()
    .from(schema.shapeEntryVersions)
    .where(
      and(
        eq(schema.shapeEntryVersions.entryId, entryId),
        eq(schema.shapeEntryVersions.number, number),
      ),
    )
    .get();
}
