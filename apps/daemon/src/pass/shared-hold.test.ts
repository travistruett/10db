import { execFileSync } from 'node:child_process';
import { ClaimKind } from '@10db/contracts';
import { acquireClaims, activeClaims, holdRecord, openHolds } from '@10db/db';
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

    const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(settings), area: 'src' });

    expect(granted.ok).toBe(true);
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

    const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(settings), area: 'src' });

    expect(granted).toMatchObject({ ok: false, conflict: { heldBy: w.runOf(people) } });
    expect(openHolds(h.store.db, w.opened.pass.id)).toEqual([]);
    expect(activeClaims(h.store.db, w.runOf(settings)).map((c) => c.name)).not.toContain('src');
    expect(h.git$('for-each-ref', `refs/10db/passes/${w.opened.pass.id}/holds/`)).toBe('');
  });
});
