import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassTurnWithFilesDto, type PassTurnDto } from '@10db/contracts';
import { openHolds, setPassTurnKept, settlePassTurn } from '@10db/db';
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

/** A commit of `files` over `parent` that no branch names, as a turn's kept commit is. */
function keptCommit(parent: string, files: Record<string, string>): string {
  const paths = Object.keys(files);
  w.h.git$('read-tree', parent);
  for (const [path, content] of Object.entries(files)) {
    const file = join(w.h.repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  w.h.git$('add', ...paths);
  const tree = w.h.git$('write-tree');
  w.h.git$('read-tree', 'HEAD');
  return w.h.git$('commit-tree', '--no-gpg-sign', tree, '-p', parent, '-m', 'kept');
}

/** Ends the turn Ready and records its kept commit over the pass branch tip. */
function kept(turn: PassTurnDto, keptSha: string | null, base: string): void {
  w.endTurn(turn);
  w.h.state.write((ctx) => {
    setPassTurnKept(ctx, turn.id, { keptSha, keptBaseSha: base, sharedSeq: null });
    settlePassTurn(ctx, turn.id);
  });
}

describe("a page's turns", () => {
  it('lists each turn with the files it changed against the turn before it, and none for a turn that changed nothing', async () => {
    w = await openPassWorld();
    const tip = w.h.git$('rev-parse', 'HEAD');
    const first = keptCommit(tip, { 'src/settings/page.tsx': 'tidied\n' });
    const second = keptCommit(first, { 'src/settings/form.tsx': 'form\nfields\n' });
    const turns = [first, second, second, null].map((sha) => {
      const turn = w.startTurn(w.settings);
      kept(turn, sha, tip);
      return turn;
    });

    const listed = await taskTurns(
      { db: w.h.store.db, git: w.h.git, files: createTurnFiles(w.h.git) },
      w.settings.id,
    );

    expect(listed.map((t) => PassTurnWithFilesDto.parse(t))).toHaveLength(4);
    expect(listed.map((t) => [t.id, t.files])).toEqual([
      [turns[0]?.id, [{ path: 'src/settings/page.tsx', added: 1, removed: 1 }]],
      [turns[1]?.id, [{ path: 'src/settings/form.tsx', added: 2, removed: 0 }]],
      [turns[2]?.id, []],
      [turns[3]?.id, []],
    ]);
  });

  it("lists only the page's own files when the pass's branch moved between two turns", async () => {
    w = await openPassWorld();
    const tip = w.h.git$('rev-parse', 'HEAD');
    const first = keptCommit(tip, { 'src/settings/page.tsx': 'tidied\n' });
    kept(w.startTurn(w.settings), first, tip);
    // Another page lands on the pass's branch, and a shared file changes there too.
    w.h.commit('src/people/page.tsx', 'people, signed off\n');
    const moved = w.h.commit('src/shared.ts', 'shared, changed\n');
    const second = keptCommit(moved, {
      'src/settings/page.tsx': 'tidied\n',
      'src/settings/form.tsx': 'form\n',
    });
    const turn = w.startTurn(w.settings);
    kept(turn, second, moved);

    const listed = await taskTurns(
      { db: w.h.store.db, git: w.h.git, files: createTurnFiles(w.h.git) },
      w.settings.id,
    );

    expect(listed.find((t) => t.id === turn.id)?.files).toEqual([
      { path: 'src/settings/form.tsx', added: 1, removed: 0 },
    ]);
  });

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

  it('lists a turn whose kept commit git no longer has with no files', async () => {
    w = await openPassWorld();
    const tip = w.h.git$('rev-parse', 'HEAD');
    kept(w.startTurn(w.settings), 'e'.repeat(40), tip);

    const [turn] = await taskTurns(
      { db: w.h.store.db, git: w.h.git, files: createTurnFiles(w.h.git) },
      w.settings.id,
    );

    expect(turn?.files).toEqual([]);
  });
});
