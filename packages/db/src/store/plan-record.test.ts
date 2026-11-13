import {
  EventType,
  PlanEntryKind,
  PlanEntryState,
  ShapeOrigin,
  type ProjectDto,
  type ShapeAttachmentId,
  type ShapeId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestStore,
  findDocument,
  getAttachmentRevision,
  getShapeEntry,
  getShapeEntryVersion,
  insertAttachmentRevision,
  insertDocumentAttachment,
  insertShape,
  listAttachmentRevisions,
  listDocuments,
  listEventsAfter,
  listShapeAttachments,
  listShapeEntries,
  seedProject,
  upsertShapeAttachment,
  upsertShapeEntry,
  type Store,
} from './index';

let store: Store;
let close: () => void;
let project: ProjectDto;
let shapeId: ShapeId;
let docId: ShapeAttachmentId;
beforeEach(() => {
  ({ store, close } = createTestStore(() => new Date(2026, 10, 12, 8, 0)));
  project = seedProject(store, { name: 'alpha' });
  shapeId = store.write((ctx) =>
    insertShape(ctx, project.id, { title: 'Remote host', origin: ShapeOrigin.ClaudeCode }),
  ).value.id;
  docId = store.write((ctx) =>
    insertDocumentAttachment(ctx, {
      shapeId,
      kind: 'plan',
      key: 'p1',
      docKey: 'p1',
      title: 'P1',
      body: '',
    }),
  ).value.id;
});
afterEach(() => {
  close();
});

const revision = (
  body: string,
  over: Partial<Parameters<typeof insertAttachmentRevision>[1]> = {},
) =>
  store.write((ctx) =>
    insertAttachmentRevision(ctx, {
      attachmentId: docId,
      body,
      sha256: `sha-of-${body}`,
      sections: [],
      note: null,
      author: null,
      bundleNumber: null,
      authoredAt: null,
      ...over,
    }),
  );

const fact = (claim: string) => ({
  shapeId,
  key: 'f-runner-packs',
  kind: PlanEntryKind.Fact,
  title: 'The runner packs once',
  body: { claim },
  anchors: [],
  sources: ['capture §6a'],
  verified: true,
  checkedAt: '2026-11-12',
  state: PlanEntryState.Current,
});

describe('document revisions', () => {
  it('the same hash again is a no-op answering the latest', () => {
    const first = revision('# P1\n').value;
    const again = revision('# P1\n');
    expect(again.value).toEqual({ row: first.row, created: false });
    expect(again.events).toEqual([]);
    expect(listAttachmentRevisions(store.db, docId)).toHaveLength(1);
  });

  it('a new body is revision 2 and the attachment body follows', () => {
    revision('# P1\n');
    const second = revision('# P1\nmore\n').value;
    expect(second.row.number).toBe(2);
    expect(second.created).toBe(true);
    expect(listShapeAttachments(store.db, shapeId)[0]?.body).toBe('# P1\nmore\n');
    expect(getAttachmentRevision(store.db, docId, 1)?.body).toBe('# P1\n');
  });

  it('a bundle number appends even with the latest’s hash', () => {
    revision('# P1\n', { bundleNumber: 1 });
    const again = revision('# P1\n', { bundleNumber: 2 }).value;
    expect(again).toMatchObject({ created: true, row: { number: 2, bundleNumber: 2 } });
  });

  it('two bundle number 2s are refused by the index', () => {
    revision('# P1\n', { bundleNumber: 2 });
    expect(() => revision('# P1 changed\n', { bundleNumber: 2 })).toThrow(/UNIQUE/);
  });

  it('a body with a BOM, CRLF and a U+203A reads back byte for byte', () => {
    const body = '﻿# Settings › Sharing\r\n\r\ntext  \r\n';
    revision(body);
    const read = getAttachmentRevision(store.db, docId, 1)?.body ?? '';
    expect(Buffer.from(read, 'utf8').equals(Buffer.from(body, 'utf8'))).toBe(true);
    expect(listShapeAttachments(store.db, shapeId)[0]?.body).toBe(body);
  });

  it('findDocument finds an imported doc by doc_key and an app spec by key', () => {
    store.write((ctx) =>
      upsertShapeAttachment(ctx, { shapeId, kind: 'spec', key: 'density', body: '# Spec' }),
    );
    expect(findDocument(store.db, shapeId, 'p1')?.id).toBe(docId);
    expect(findDocument(store.db, shapeId, 'density')?.body).toBe('# Spec');
    expect(findDocument(store.db, shapeId, 'p2')).toBeUndefined();
    expect(listDocuments(store.db, shapeId).map((d) => d.documentKey)).toEqual(['p1', 'density']);
  });
});

describe('entries', () => {
  it('an entry’s first save is version 1', () => {
    const saved = store.write((ctx) => upsertShapeEntry(ctx, fact('Packs once'))).value;
    expect(saved).toMatchObject({ version: 1, changed: true });
    expect(getShapeEntry(store.db, shapeId, 'f-runner-packs')).toMatchObject({
      version: 1,
      body: { claim: 'Packs once' },
    });
  });

  it('an unchanged entry writes no version', () => {
    store.write((ctx) => upsertShapeEntry(ctx, fact('Packs once')));
    const again = store.write((ctx) => upsertShapeEntry(ctx, fact('Packs once')));
    expect(again.value).toMatchObject({ version: 1, changed: false });
    expect(again.events).toEqual([]);
  });

  it('a changed claim is version 2 and version 1 still reads the old claim', () => {
    const first = store.write((ctx) => upsertShapeEntry(ctx, fact('Packs once'))).value;
    const second = store.write((ctx) => upsertShapeEntry(ctx, fact('Packs twice'))).value;
    expect(second).toMatchObject({ version: 2, changed: true });
    expect(getShapeEntryVersion(store.db, first.row.id, 1)?.snapshot).toMatchObject({
      body: { claim: 'Packs once' },
    });
    expect(listShapeEntries(store.db, shapeId)).toMatchObject([
      { key: 'f-runner-packs', version: 2, body: { claim: 'Packs twice' } },
    ]);
  });
});

describe('events', () => {
  it('each write appends plan.record_changed in its transaction', () => {
    const wrote = store.write((ctx) => upsertShapeEntry(ctx, fact('Packs once')));
    expect(wrote.events.map((e) => [e.type, e.entityType, e.entityId, e.data])).toEqual([
      [EventType.PlanRecordChanged, 'shape', shapeId, { projectId: project.id, what: 'entries' }],
    ]);
    const before = listEventsAfter(store.db, 0, 1000).length;
    expect(() =>
      store.write((ctx) => {
        upsertShapeEntry(ctx, { ...fact('Rolled back'), key: 'f-other' });
        insertAttachmentRevision(ctx, {
          attachmentId: docId,
          body: 'x',
          sha256: 'x',
          sections: [],
          note: null,
          author: null,
          bundleNumber: null,
          authoredAt: null,
        });
        throw new Error('caller fails');
      }),
    ).toThrow('caller fails');
    expect(getShapeEntry(store.db, shapeId, 'f-other')).toBeUndefined();
    expect(listAttachmentRevisions(store.db, docId)).toEqual([]);
    expect(listEventsAfter(store.db, 0, 1000)).toHaveLength(before);
  });
});
