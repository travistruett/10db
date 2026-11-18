import { openHolds } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { grantSharedHold, keepHold } from './shared-chain';
import { keepTurnWork } from './kept-work';
import { createTurnFiles, taskTurns } from './turns';

// Workbench spec §4.3, §11: a page's turns, each with the files it changed against the turn before.

let w: PassWorld;
afterEach(() => {
  w.close();
});

describe("a page's turns", () => {
  it('lists the shared files a turn kept through its hold after its page files, and none in a turn that held no shared area', async () => {
    w = await openPassWorld();
    const settings = w.runOf(w.settings);
    const shared = w.startTurn(w.settings);
    const granted = await grantSharedHold(w.deps, { workstreamId: settings, area: 'src' });
    if (!granted?.ok) throw new Error('src was not granted');
    w.write('src/button.ts', 'button\nwider\n');
    w.write('src/settings/page.tsx', 'settings work\n');
    const [hold] = openHolds(w.h.store.db, w.opened.pass.id);
    if (!hold) throw new Error('no hold');
    // The turn's end: the hold is kept and let go, then the page's work is kept.
    await keepHold(w.deps, { claimId: hold.claimId });
    w.endTurn(shared);
    await keepTurnWork(w.deps, { workstreamId: settings, turnId: shared.id });
    const later = w.startTurn(w.settings);
    w.write('src/settings/page.tsx', 'settings work, again\n');
    w.endTurn(later);
    await keepTurnWork(w.deps, { workstreamId: settings, turnId: later.id });
    const people = w.startTurn(w.people);
    w.write('src/people/page.tsx', 'people work\n');
    w.endTurn(people);
    await keepTurnWork(w.deps, { workstreamId: w.runOf(w.people), turnId: people.id });

    const deps = { db: w.h.store.db, git: w.h.git, files: createTurnFiles(w.h.git) };
    expect((await taskTurns(deps, w.settings.id)).map((t) => [t.id, t.files])).toEqual([
      [
        shared.id,
        [
          { path: 'src/settings/page.tsx', added: 1, removed: 1 },
          { path: 'src/button.ts', added: 2, removed: 0 },
        ],
      ],
      [later.id, [{ path: 'src/settings/page.tsx', added: 1, removed: 1 }]],
    ]);
    expect((await taskTurns(deps, w.people.id)).map((t) => t.files)).toEqual([
      [{ path: 'src/people/page.tsx', added: 1, removed: 1 }],
    ]);
  });
});
