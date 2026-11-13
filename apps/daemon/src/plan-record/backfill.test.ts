import { ShapeOrigin } from '@10db/contracts';
import {
  createTestStore,
  insertShape,
  listAttachmentRevisions,
  listShapeAttachments,
  seedProject,
  upsertShapeAttachment,
} from '@10db/db';
import { describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { backfillAttachmentRevisions } from './backfill';

describe('backfillAttachmentRevisions', () => {
  it('a spec and an eval written before revisions get revision 1 with their sections, once', () => {
    const { store, close } = createTestStore();
    try {
      const state = createStateStore(store, createEventBus());
      const project = seedProject(store, { name: 'alpha' });
      const shape = state.write((ctx) =>
        insertShape(ctx, project.id, { title: 'Density', origin: ShapeOrigin.App }),
      );
      state.write((ctx) => {
        upsertShapeAttachment(ctx, {
          shapeId: shape.id,
          kind: 'spec',
          key: 'density',
          body: '# Density\n## Scope\nCards only.\n',
        });
        upsertShapeAttachment(ctx, {
          shapeId: shape.id,
          kind: 'eval',
          key: 'density',
          body: '{\n  "objective": "# not a heading"\n}',
        });
      });
      expect(backfillAttachmentRevisions(state)).toBe(2);
      expect(backfillAttachmentRevisions(state)).toBe(0);
      const revisions = listShapeAttachments(store.db, shape.id).map((a) => [
        a.kind,
        listAttachmentRevisions(store.db, a.id).map((r) => ({
          number: r.number,
          body: r.body,
          author: r.author,
          note: r.note,
          slugs: r.sections.map((s) => s.slug),
        })),
      ]);
      expect(revisions).toEqual([
        [
          'spec',
          [
            {
              number: 1,
              body: '# Density\n## Scope\nCards only.\n',
              author: '10db',
              note: 'kept before revisions',
              slugs: ['density', 'scope'],
            },
          ],
        ],
        [
          'eval',
          [
            {
              number: 1,
              body: '{\n  "objective": "# not a heading"\n}',
              author: '10db',
              note: 'kept before revisions',
              slugs: [],
            },
          ],
        ],
      ]);
    } finally {
      close();
    }
  });
});
