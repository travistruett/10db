import { execFileSync } from 'node:child_process';
import { ClaimKind } from '@10db/contracts';
import {
  acquireClaims,
  activeClaims,
  getHold,
  holdRecord,
  listSharedChanges,
  openHolds,
  releaseClaim,
  schema,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { isolatedGitEnv } from '../../test/fixtures';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { grantSharedHold, holdRef } from './index';

// Workbench spec §7.2, §7.3: a shared area's grant records what the area already held, never a
// page's file, and writes the claim and its hold together.

let w: PassWorld;
afterEach(() => {
  w.close();
});

const hash = (text: string) =>
  execFileSync('git', ['hash-object', '--stdin'], { input: text, env: isolatedGitEnv() })
    .toString()
    .trim();

describe('grantSharedHold', () => {
  it("records the area's dirt before the hold with its content, and no page's file", async () => {
    w = await openPassWorld();
    const { h, settings } = w;
    w.write('src/shared.ts', "the builder's edit before the hold\n");
    w.write('src/button.ts', 'a new file\n');
    w.write('src/settings/page.tsx', 'a page edit\n');
    w.write('src/people/page.tsx', "a neighbour's page edit\n");

    w.startTurn(settings);
    const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(settings), area: 'src' });

    expect(granted?.ok).toBe(true);
    const [hold] = openHolds(h.store.db, w.opened.pass.id);
    expect(hold).toMatchObject({ seq: 1, area: 'src', taskId: settings.id, closedAt: null });
    if (!hold) throw new Error('no hold');
    expect(activeClaims(h.store.db, w.runOf(settings)).map((c) => c.id)).toContain(hold.claimId);
    expect(holdRecord(h.store.db, hold.claimId)).toEqual([
      { path: 'src/button.ts', blob: hash('a new file\n') },
      { path: 'src/shared.ts', blob: hash("the builder's edit before the hold\n") },
    ]);
    const ref = holdRef(w.opened.pass.id, hold.claimId);
    expect(h.git$('rev-parse', ref)).toBe(hold.recordSha);
    expect(h.git$('show', `${ref}:src/shared.ts`)).toBe("the builder's edit before the hold");
    // Pages are never in a record: their content is the page's own.
    expect(h.git$('show', `${ref}:src/settings/page.tsx`)).toBe('settings');
    expect(h.git$('rev-parse', 'HEAD')).toBe(w.opened.pass.startSha);
  });

  it('writes nothing when another task took the claim first', async () => {
    w = await openPassWorld();
    const { h, settings, people } = w;
    h.state.write((c) =>
      acquireClaims(c, {
        projectId: h.project.id,
        workstreamId: w.runOf(people),
        requests: [{ kind: ClaimKind.Area, name: 'src' }],
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    w.startTurn(settings);
    const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(settings), area: 'src' });

    expect(granted).toMatchObject({ ok: false, conflict: { heldBy: w.runOf(people) } });
    expect(openHolds(h.store.db, w.opened.pass.id)).toEqual([]);
    expect(activeClaims(h.store.db, w.runOf(settings)).map((c) => c.name)).not.toContain('src');
    expect(h.git$('for-each-ref', `refs/10db/passes/${w.opened.pass.id}/holds/`)).toBe('');
  });

  it("grants nothing once the lane's turn has ended", async () => {
    w = await openPassWorld();
    const turn = w.startTurn(w.settings);
    w.endTurn(turn);

    expect(
      await grantSharedHold(w.deps, { workstreamId: w.runOf(w.settings), area: 'src' }),
    ).toBeNull();
    expect(openHolds(w.h.store.db, w.opened.pass.id)).toEqual([]);
    expect(activeClaims(w.h.store.db, w.runOf(w.settings)).map((c) => c.name)).not.toContain('src');
  });

  it("keeps a hold whose claim was taken from its lane before the area's next grant", async () => {
    w = await openPassWorld();
    const { h, settings, people } = w;
    w.startTurn(settings);
    await grantSharedHold(w.deps, { workstreamId: w.runOf(settings), area: 'src' });
    const [first] = openHolds(h.store.db, w.opened.pass.id);
    if (!first) throw new Error('no hold');
    w.write('src/button.ts', "settings' half-written button\n");
    // A deadlock's yield releases the claim and leaves the hold.
    h.state.write((c) => releaseClaim(c, first.claimId));

    w.startTurn(people);
    const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(people), area: 'src' });

    expect(granted?.ok).toBe(true);
    expect(getHold(h.store.db, first.claimId).closedAt).not.toBeNull();
    expect(listSharedChanges(h.store.db, w.opened.pass.id)).toMatchObject([
      { seq: 1, taskId: settings.id, paths: ['src/button.ts'] },
    ]);
    const [second] = openHolds(h.store.db, w.opened.pass.id);
    expect(second).toMatchObject({ seq: 2, taskId: people.id });
    if (!second) throw new Error('no second hold');
    expect(holdRecord(h.store.db, second.claimId)).toEqual([]);
  });

  it("lets a lost claim's hold go when it cannot be kept, and grants the area all the same", async () => {
    w = await openPassWorld();
    const { h, settings, people } = w;
    w.startTurn(settings);
    await grantSharedHold(w.deps, { workstreamId: w.runOf(settings), area: 'src' });
    const [first] = openHolds(h.store.db, w.opened.pass.id);
    if (!first) throw new Error('no hold');
    h.state.write((c) => releaseClaim(c, first.claimId));
    // Its record's commit is gone too, so it cannot be kept.
    h.store.db
      .update(schema.passHolds)
      .set({ recordSha: '0'.repeat(40) })
      .run();

    w.startTurn(people);
    const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(people), area: 'src' });

    expect(granted?.ok).toBe(true);
    expect(getHold(h.store.db, first.claimId)).toMatchObject({ empty: true });
    expect(openHolds(h.store.db, w.opened.pass.id).map((o) => o.taskId)).toEqual([people.id]);
  });
});
