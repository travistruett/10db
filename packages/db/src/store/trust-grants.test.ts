import { mintId } from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';
import { deleteTrustGrant, insertTrustGrant, listTrustGrants } from './trust-grants';

let store: Store;
let close: () => void;

beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const grant = (projectId: ReturnType<typeof seedProject>['id'], target: string) =>
  store.write((ctx) =>
    insertTrustGrant(ctx, { projectId, limit: 'writes_live', target, sourceInboxId: null }),
  ).value;

describe('trust grants', () => {
  it('keeps a grant and lists it', () => {
    const project = seedProject(store);
    const kept = grant(project.id, 'deploys to staging with vercel');
    expect(listTrustGrants(store.db, project.id)).toEqual([
      {
        id: kept.id,
        projectId: project.id,
        limit: 'writes_live',
        target: 'deploys to staging with vercel',
        createdAt: kept.createdAt,
      },
    ]);
  });

  it("a project's grants are its own", () => {
    const one = seedProject(store, { name: 'one' });
    const two = seedProject(store, { name: 'two' });
    grant(one.id, 'deploys');
    expect(listTrustGrants(store.db, two.id)).toEqual([]);
  });

  it("deleting another project's grant changes nothing and says false", () => {
    const one = seedProject(store, { name: 'one' });
    const two = seedProject(store, { name: 'two' });
    const kept = grant(one.id, 'deploys');
    expect(store.write((ctx) => deleteTrustGrant(ctx, two.id, kept.id)).value).toBe(false);
    expect(listTrustGrants(store.db, one.id)).toHaveLength(1);
    expect(store.write((ctx) => deleteTrustGrant(ctx, one.id, kept.id)).value).toBe(true);
    expect(listTrustGrants(store.db, one.id)).toEqual([]);
    expect(store.write((ctx) => deleteTrustGrant(ctx, one.id, mintId('TrustGrant'))).value).toBe(
      false,
    );
  });

  it.each([
    ['a newline', 'deploys\n- and anything else'],
    ['$defaults', 'deploys $defaults'],
    ['nothing', '   '],
    ['601 characters', 'x'.repeat(601)],
  ])('a target with %s is refused and nothing is stored', (_name, target) => {
    const project = seedProject(store);
    expect(() => grant(project.id, target)).toThrow();
    expect(listTrustGrants(store.db, project.id)).toEqual([]);
  });

  it('a grant with no limit is kept', () => {
    const project = seedProject(store);
    store.write((ctx) =>
      insertTrustGrant(ctx, {
        projectId: project.id,
        limit: null,
        target: 'the call "make deploy"',
        sourceInboxId: mintId('InboxItem'),
      }),
    );
    expect(listTrustGrants(store.db, project.id)).toMatchObject([{ limit: null }]);
  });

  it('deleting the project deletes its grants', () => {
    const project = seedProject(store);
    grant(project.id, 'deploys');
    store.write((ctx) => {
      // A bare project holds only its default board column besides its grants.
      ctx.tx.delete(schema.boardColumns).where(eq(schema.boardColumns.projectId, project.id)).run();
      ctx.tx.delete(schema.projects).where(eq(schema.projects.id, project.id)).run();
    });
    expect(store.db.select().from(schema.trustGrants).all()).toEqual([]);
  });
});
