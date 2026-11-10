import { execFileSync } from 'node:child_process';
import {
  activeClaims,
  getHold,
  getPassTurn,
  listSharedChanges,
  listTaskThread,
  openHolds,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { isolatedGitEnv } from '../../test/fixtures';
import { openPassWorld, PASS_PROJECT, type PassWorld } from '../../test/pass-world';
import { grantSharedHold, keepHold, keepTurnWork, landSharedChanges, sharedRef } from './index';
import { sharedNeeded } from './shared-chain';

// Workbench spec §7.2: a hold keeps only what changed while it was held, as one change on the pass's
// shared chain numbered as its grant was, and its area is released.

let w: PassWorld;
afterEach(() => {
  w.close();
});

const hash = (text: string) =>
  execFileSync('git', ['hash-object', '--stdin'], { input: text, env: isolatedGitEnv() })
    .toString()
    .trim();

/** A pass with two more shared areas, `styles` and `assets`. */
const twoSharedAreas = () =>
  openPassWorld({
    project: {
      areas: [
        ...(PASS_PROJECT.areas ?? []),
        { name: 'styles', globs: ['styles/**'], role: 'shared' },
        { name: 'assets', globs: ['assets/**'], role: 'shared' },
      ],
    },
  });

async function grant(task: PassWorld['settings'], area: string) {
  w.startTurn(task);
  const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(task), area });
  if (!granted?.ok) throw new Error(`${area} was not granted`);
  const hold = openHolds(w.h.store.db, w.opened.pass.id).find((h) => h.area === area);
  if (!hold) throw new Error(`no hold on ${area}`);
  return hold;
}

describe('keepHold', () => {
  it("keeps only the hold's own edits, a file dirty before and changed in it whole, and says so", async () => {
    w = await openPassWorld();
    const { h, settings, people } = w;
    w.write('src/shared.ts', "the builder's edit\n");
    w.write('src/notes.ts', 'dirt the hold never touches\n');
    const hold = await grant(settings, 'src');
    w.write('src/shared.ts', "the builder's edit\nand the agent's\n");
    w.write('src/button.ts', 'a new button\n');
    w.write('src/people/page.tsx', "a neighbour's page\n");

    const kept = await keepHold(w.deps, { claimId: hold.claimId });

    expect(kept).toMatchObject({ seq: 1, made: true, paths: ['src/button.ts', 'src/shared.ts'] });
    const [change] = listSharedChanges(h.store.db, w.opened.pass.id);
    expect(change).toMatchObject({
      seq: 1,
      taskId: settings.id,
      sha: kept.sha,
      paths: ['src/button.ts', 'src/shared.ts'],
      blobs: {
        'src/button.ts': hash('a new button\n'),
        'src/shared.ts': hash("the builder's edit\nand the agent's\n"),
      },
      dirtyKept: true,
    });
    const ref = sharedRef(w.opened.pass.id);
    expect(h.git$('rev-parse', ref)).toBe(kept.sha);
    expect(h.git$('rev-parse', `${ref}^`)).toBe(w.opened.pass.startSha);
    // The dirt it never touched and the neighbour's page are not in its change.
    expect(h.git$('ls-tree', '--name-only', ref, 'src/notes.ts')).toBe('');
    expect(h.git$('show', `${ref}:src/people/page.tsx`)).toBe('people');
    expect(getHold(h.store.db, hold.claimId)).toMatchObject({ empty: false });
    expect(getHold(h.store.db, hold.claimId).closedAt).not.toBeNull();
    expect(activeClaims(h.store.db, w.runOf(settings)).map((c) => c.name)).not.toContain('src');
    expect(listTaskThread(h.store.db, people.id).map((m) => m.body)).toContain(
      'Settings: UI work changed shared `src/button.ts`, `src/shared.ts`; it includes edits that were already in your folder.',
    );
    expect(h.git$('rev-parse', 'HEAD')).toBe(w.opened.pass.startSha);
  });

  it('closes a hold that changed nothing as empty, with no chain commit', async () => {
    w = await openPassWorld();
    w.write('src/shared.ts', "the builder's edit\n");
    const hold = await grant(w.settings, 'src');

    expect(await keepHold(w.deps, { claimId: hold.claimId })).toMatchObject({
      sha: null,
      paths: [],
    });

    expect(getHold(w.h.store.db, hold.claimId)).toMatchObject({ empty: true });
    expect(listSharedChanges(w.h.store.db, w.opened.pass.id)).toEqual([]);
    expect(w.h.git$('for-each-ref', sharedRef(w.opened.pass.id))).toBe('');
  });

  it('keeps every one of three turn ends racing for the chain', async () => {
    w = await twoSharedAreas();
    const src = await grant(w.settings, 'src');
    const styles = await grant(w.people, 'styles');
    const assets = await grant(w.settings, 'assets');
    w.write('src/button.ts', 'button\n');
    w.write('styles/app.css', 'app\n');
    w.write('assets/logo.svg', 'logo\n');

    const kept = await Promise.all(
      [src, styles, assets].map((hold) => keepHold(w.deps, { claimId: hold.claimId })),
    );

    const ref = sharedRef(w.opened.pass.id);
    const line = w.h.git$('rev-list', `${w.opened.pass.startSha}..${ref}`).split('\n');
    expect(line.sort()).toEqual(kept.map((k) => k.sha).sort());
    expect(w.h.git$('show', `${ref}:src/button.ts`)).toBe('button');
    expect(w.h.git$('show', `${ref}:styles/app.css`)).toBe('app');
    expect(w.h.git$('show', `${ref}:assets/logo.svg`)).toBe('logo');
    expect(openHolds(w.h.store.db, w.opened.pass.id)).toEqual([]);
  });

  it('lands changes in number order when two areas end opposite to their grants', async () => {
    w = await twoSharedAreas();
    const first = await grant(w.settings, 'src');
    const second = await grant(w.people, 'styles');
    w.write('src/button.ts', 'button\n');
    w.write('styles/app.css', 'app\n');
    await keepHold(w.deps, { claimId: second.claimId });
    await keepHold(w.deps, { claimId: first.claimId });

    expect(listSharedChanges(w.h.store.db, w.opened.pass.id).map((c) => c.seq)).toEqual([1, 2]);
    const landed = await landSharedChanges(w.deps, { passId: w.opened.pass.id, upTo: 2 });

    expect(landed.map((l) => l.seq)).toEqual([1, 2]);
    const tip = w.h.git$('rev-parse', w.branch);
    expect(landed[1]?.landedSha).toBe(tip);
    expect(w.h.git$('rev-parse', `${tip}^`)).toBe(landed[0]?.landedSha);
    expect(w.h.git$('show', '--name-only', '--format=', `${tip}^`)).toBe('src/button.ts');
    expect(w.h.git$('show', '--name-only', '--format=', tip)).toBe('styles/app.css');
    // Landing again lands nothing twice.
    expect(await landSharedChanges(w.deps, { passId: w.opened.pass.id, upTo: 2 })).toEqual([]);
    expect(w.h.git$('rev-parse', w.branch)).toBe(tip);
  });
});

describe('sharedNeeded', () => {
  it("needs every change granted when the page's turn was kept, a hold still open included", async () => {
    w = await twoSharedAreas();
    const mine = await grant(w.settings, 'src');
    w.write('src/button.ts', 'button\n');
    await keepHold(w.deps, { claimId: mine.claimId });
    // People's agent is still writing a shared file this page was built and looked at with.
    const theirs = await grant(w.people, 'styles');
    const turn = w.startTurn(w.settings);
    w.write('src/settings/page.tsx', 'uses the button\n');
    await keepTurnWork(w.deps, { workstreamId: w.runOf(w.settings), turnId: turn.id });

    expect(getPassTurn(w.h.store.db, turn.id).sharedSeq).toBe(2);
    const needed = sharedNeeded(w.h.store.db, w.opened.pass.id, w.settings.id);
    expect(needed.upTo).toBe(2);
    expect(needed.openHolds.map((h) => h.claimId)).toEqual([theirs.claimId]);
    expect(sharedNeeded(w.h.store.db, w.opened.pass.id, w.people.id)).toEqual({
      upTo: 0,
      openHolds: [],
    });
  });
});
