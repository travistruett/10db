import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassTurnWithFilesDto, type PassTurnDto } from '@10db/contracts';
import { setPassTurnKept, settlePassTurn } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
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
