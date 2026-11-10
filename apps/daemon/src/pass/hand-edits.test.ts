import { unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { getPassTurn, listTaskThreadRows } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { foldHandEdits, keepTurnWork, passKeptRef } from './index';

// Workbench spec §6.4: when the builder sends a message, files of the page that differ from what its
// last turn left are the builder's hand edits: kept at once, named on the thread and to the agent.

let w: PassWorld;
afterEach(() => {
  w.close();
});

const notices = (world: PassWorld) =>
  listTaskThreadRows(world.h.store.db, world.settings.id)
    .filter((m) => m.kind === 'notice')
    .map((m) => m.body);

/** Turn 1 of Settings: the agent edits its page and the turn's work is kept. */
async function afterFirstTurn(world: PassWorld) {
  const turn = world.startTurn(world.settings);
  world.write('src/settings/page.tsx', 'settings\nby the agent\n');
  const kept = await keepTurnWork(world.deps, {
    workstreamId: world.runOf(world.settings),
    turnId: turn.id,
  });
  world.endTurn(turn);
  return kept;
}

/** Sets a file's modification time. */
function touch(world: PassWorld, path: string, at: Date): void {
  utimesSync(join(world.h.repo, path), at, at);
}

describe('foldHandEdits', () => {
  it("keeps the builder's edits since the last turn as one more kept commit, named on the thread and to the agent", async () => {
    w = await openPassWorld();
    const before = await afterFirstTurn(w);
    w.write('src/settings/page.tsx', 'settings\nby the agent\nand by hand\n');
    unlinkSync(join(w.h.repo, 'src/settings/old.tsx'));

    const fold = await foldHandEdits(w.deps, { workstreamId: w.runOf(w.settings) });

    expect(fold.byHand).toEqual([
      { path: 'src/settings/old.tsx', added: 0, removed: 1 },
      { path: 'src/settings/page.tsx', added: 1, removed: 0 },
    ]);
    expect(fold.whileWorking).toBeNull();
    // The edits ride the task's kept work, on the turn's commit.
    const ref = passKeptRef(w.opened.pass.id, w.settings.id);
    expect(fold.kept).toMatchObject({ made: true, keptSha: w.h.git$('rev-parse', ref) });
    expect(w.h.git$('rev-parse', `${ref}^`)).toBe(before.keptSha);
    expect(w.h.git$('show', `${ref}:src/settings/page.tsx`)).toBe(
      'settings\nby the agent\nand by hand',
    );
    expect(notices(w)).toEqual([
      'You edited 2 files by hand; they are kept with this page:\n' +
        '- src/settings/old.tsx +0 −1\n' +
        '- src/settings/page.tsx +1 −0',
    ]);
    expect(fold.agentNote).toBe(
      'The builder edited these files by hand since your last turn. Keep their changes:\n' +
        '- src/settings/old.tsx +0 −1\n' +
        '- src/settings/page.tsx +1 −0',
    );
  });

  it('does nothing when nothing changed since the last turn', async () => {
    w = await openPassWorld();
    const before = await afterFirstTurn(w);
    const fold = await foldHandEdits(w.deps, { workstreamId: w.runOf(w.settings) });
    expect(fold).toMatchObject({ byHand: [], whileWorking: null, agentNote: null });
    expect(fold.kept).toMatchObject({ keptSha: before.keptSha, made: false, turnFiles: [] });
    expect(notices(w)).toEqual([]);
  });

  it("names a file changed while another page's agent was working, never as the builder's", async () => {
    w = await openPassWorld();
    await afterFirstTurn(w);
    const working = w.startTurn(w.people);
    w.write('src/settings/page.tsx', 'written through a shell\n');
    w.write('src/settings/later.tsx', 'by hand, after\n');
    const started = new Date(getPassTurn(w.h.store.db, working.id).startedAt);
    touch(w, 'src/settings/page.tsx', new Date(started.getTime() + 500));
    w.endTurn(working);
    const ended = getPassTurn(w.h.store.db, working.id).endedAt;
    if (ended === null) throw new Error('the turn did not end');
    touch(w, 'src/settings/later.tsx', new Date(new Date(ended).getTime() + 60_000));

    const fold = await foldHandEdits(w.deps, { workstreamId: w.runOf(w.settings) });

    expect(fold.byHand).toEqual([{ path: 'src/settings/later.tsx', added: 1, removed: 0 }]);
    expect(fold.whileWorking).toEqual({
      lanes: ['People: UI work'],
      files: [{ path: 'src/settings/page.tsx', added: 1, removed: 2 }],
    });
    expect(fold.kept.turnFiles.map((f) => f.path)).toEqual([
      'src/settings/later.tsx',
      'src/settings/page.tsx',
    ]);
    expect(notices(w)).toEqual([
      'You edited 1 file by hand; it is kept with this page:\n- src/settings/later.tsx +1 −0\n\n' +
        "1 file changed outside this page's turns, while People: UI work was working:\n" +
        '- src/settings/page.tsx +1 −2',
    ]);
  });

  it('marks a page file the folder held before the pass as such', async () => {
    w = await openPassWorld({
      before: ({ write }) => {
        write('src/settings/page.tsx', 'edited before the pass\n');
      },
    });
    const fold = await foldHandEdits(w.deps, { workstreamId: w.runOf(w.settings) });
    expect(fold.byHand).toEqual([{ path: 'src/settings/page.tsx', added: 1, removed: 1 }]);
    expect(fold.kept.fromBeforePass).toEqual(['src/settings/page.tsx']);
    expect(notices(w)).toEqual([
      'You edited 1 file by hand; it is kept with this page:\n' +
        '- src/settings/page.tsx +1 −1 (from before the pass)',
    ]);
    expect(fold.agentNote).toContain('- src/settings/page.tsx +1 −1 (from before the pass)');
  });

  it("leaves an edit made during the page's own turn to that turn", async () => {
    w = await openPassWorld();
    w.startTurn(w.settings);
    w.write('src/settings/page.tsx', 'mid-turn\n');
    const fold = await foldHandEdits(w.deps, { workstreamId: w.runOf(w.settings) });
    expect(fold).toMatchObject({ byHand: [], whileWorking: null, agentNote: null });
    expect(w.h.git$('for-each-ref', 'refs/10db/passes/')).not.toContain(w.settings.id);
    expect(notices(w)).toEqual([]);
  });
});
