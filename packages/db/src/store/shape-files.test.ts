import { ShapeOrigin, ShapeProposalState, type ShapeId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countShapeFiles,
  createTestStore,
  getShapeFile,
  insertShape,
  insertShapeFile,
  insertShapeProposal,
  listShapeFiles,
  listShapeProposals,
  listUntoldShapeFiles,
  markShapeFilesInline,
  markShapeFilesTold,
  seedProject,
  type Store,
} from './index';

// Shape spec §5.4, §13: a dropped file's name, type, size and stored path; and §6, the round a
// proposal was created in, which tells "new" from "changed".

let store: Store;
let close: () => void;
let shapeId: ShapeId;
beforeEach(() => {
  ({ store, close } = createTestStore());
  const project = seedProject(store, { name: 'alpha' });
  shapeId = store.write((ctx) =>
    insertShape(ctx, project.id, { title: 'Board', origin: ShapeOrigin.App }),
  ).value.id;
});
afterEach(() => {
  close();
});

const file = (name: string) => ({
  shapeId,
  name,
  mediaType: 'text/markdown',
  size: 12,
  storedPath: `/data/shapes/${shapeId}/files/${name}`,
});

describe('shape files', () => {
  it('stores a file and reads it back, oldest first', () => {
    const a = store.write((ctx) => insertShapeFile(ctx, file('a.md'))).value;
    store.write((ctx) => insertShapeFile(ctx, file('b.md')));
    expect(listShapeFiles(store.db, shapeId).map((f) => f.name)).toEqual(['a.md', 'b.md']);
    expect(getShapeFile(store.db, a.id)).toMatchObject({
      name: 'a.md',
      mediaType: 'text/markdown',
      size: 12,
      storedPath: `/data/shapes/${shapeId}/files/a.md`,
    });
    expect(countShapeFiles(store.db, shapeId)).toBe(2);
  });

  it('counts a conversation’s files alone', () => {
    const project = seedProject(store, { name: 'beta' });
    const other = store.write((ctx) =>
      insertShape(ctx, project.id, { title: 'Other', origin: ShapeOrigin.App }),
    ).value;
    store.write((ctx) => insertShapeFile(ctx, file('a.md')));
    expect(countShapeFiles(store.db, other.id)).toBe(0);
  });

  it('is untold until marked told, and only the files named are marked', () => {
    const a = store.write((ctx) => insertShapeFile(ctx, file('a.md'))).value;
    const b = store.write((ctx) => insertShapeFile(ctx, file('b.md'))).value;
    expect(a.toldAt).toBeNull();
    expect(listUntoldShapeFiles(store.db, shapeId).map((f) => f.name)).toEqual(['a.md', 'b.md']);
    const at = store.write((ctx) => {
      markShapeFilesTold(ctx, [a.id]);
      return ctx.now;
    }).value;
    expect(getShapeFile(store.db, a.id).toldAt).toBe(at);
    expect(getShapeFile(store.db, b.id).toldAt).toBeNull();
    expect(listUntoldShapeFiles(store.db, shapeId).map((f) => f.name)).toEqual(['b.md']);
  });

  it('marks nothing when no file is named', () => {
    store.write((ctx) => insertShapeFile(ctx, file('a.md')));
    store.write((ctx) => {
      markShapeFilesTold(ctx, []);
    });
    expect(listUntoldShapeFiles(store.db, shapeId)).toHaveLength(1);
  });

  it('marks the files a turn sent inline, and a fresh session clears the others first', () => {
    const a = store.write((ctx) => insertShapeFile(ctx, file('a.png'))).value;
    const b = store.write((ctx) => insertShapeFile(ctx, file('b.png'))).value;
    const inline = () => listShapeFiles(store.db, shapeId).map((f) => f.inlineSent);
    expect(inline()).toEqual([false, false]);
    store.write((ctx) => {
      markShapeFilesInline(ctx, shapeId, [a.id], false);
    });
    expect(inline()).toEqual([true, false]);
    store.write((ctx) => {
      markShapeFilesInline(ctx, shapeId, [b.id], false);
    });
    expect(inline()).toEqual([true, true]);
    store.write((ctx) => {
      markShapeFilesInline(ctx, shapeId, [b.id], true);
    });
    expect(inline()).toEqual([false, true]);
    store.write((ctx) => {
      markShapeFilesInline(ctx, shapeId, [], true);
    });
    expect(inline()).toEqual([false, false]);
  });
});

describe('a proposal’s created round', () => {
  it('is stored with the row', () => {
    store.write((ctx) =>
      insertShapeProposal(ctx, {
        shapeId,
        key: 'a',
        kind: 'question',
        state: ShapeProposalState.Pending,
        round: 3,
        createdRound: 3,
        pinned: [],
        body: {},
        taskHashes: {},
        sourceMessageIds: [],
      }),
    );
    expect(listShapeProposals(store.db, shapeId)[0]).toMatchObject({ round: 3, createdRound: 3 });
  });
});
