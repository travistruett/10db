import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTask, listSharedChanges, listTaskThread, openHolds } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import {
  dropShared,
  grantSharedHold,
  keepHold,
  sharedRef,
  sharedUnlanded,
  takeOut,
  TakeOutWithin,
} from './index';

// Workbench spec §7.2 (D17): a page's shared change that has not landed can be dropped when it is
// taken out. Its files go back to what they were when the hold was granted, the builder's own
// earlier edit included; it is refused when a later change touches them or they changed on disk.

let w: PassWorld;
afterEach(() => {
  w.close();
});

const read = (path: string) => readFileSync(join(w.h.repo, path), 'utf8');

/** `task` holds `src` for a turn in which `edit` writes, and the turn's end keeps it. */
async function sharedTurn(task: PassWorld['settings'], edit: () => void): Promise<number> {
  w.startTurn(task);
  const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(task), area: 'src' });
  if (!granted?.ok) throw new Error('src was not granted');
  const hold = openHolds(w.h.store.db, w.opened.pass.id).find((h) => h.taskId === task.id);
  if (!hold) throw new Error('no hold');
  edit();
  return (await keepHold(w.deps, { claimId: hold.claimId })).seq;
}

describe('dropShared', () => {
  it("puts each file back as the grant found it, the builder's earlier edit included", async () => {
    w = await openPassWorld();
    w.write('src/shared.ts', "the builder's edit\n");
    const seq = await sharedTurn(w.settings, () => {
      w.write('src/shared.ts', "the builder's edit\nand the agent's\n");
      w.write('src/button.ts', 'a new button\n');
    });

    expect(
      (await sharedUnlanded(w.deps, { passId: w.opened.pass.id, taskId: w.settings.id }))[0],
    ).toEqual({
      seq,
      paths: ['src/button.ts', 'src/shared.ts'],
      dropRefusal: null,
      laterPages: [],
    });
    const dropped = await dropShared(w.deps, { passId: w.opened.pass.id, seq });

    expect(dropped).toMatchObject({ seq, dropSeq: 2, left: [], refused: null });
    expect(read('src/shared.ts')).toBe("the builder's edit\n");
    expect(existsSync(join(w.h.repo, 'src/button.ts'))).toBe(false);
    const ref = sharedRef(w.opened.pass.id);
    expect(w.h.git$('show', `${ref}:src/shared.ts`)).toBe("the builder's edit");
    expect(w.h.git$('ls-tree', '--name-only', ref, 'src/button.ts')).toBe('');
    expect(listSharedChanges(w.h.store.db, w.opened.pass.id)).toMatchObject([
      { seq, droppedBy: 2 },
      { seq: 2, dropOf: seq, taskId: w.settings.id },
    ]);
    // Again, after a restart between the files and the row: nothing is written twice.
    expect(await dropShared(w.deps, { passId: w.opened.pass.id, seq })).toMatchObject({
      dropSeq: 2,
      refused: null,
    });
    expect(listSharedChanges(w.h.store.db, w.opened.pass.id)).toHaveLength(2);
  });

  it("is refused while a later page's change touches its files, naming that page first", async () => {
    w = await openPassWorld();
    const first = await sharedTurn(w.settings, () => {
      w.write('src/shared.ts', 'settings\n');
    });
    await sharedTurn(w.people, () => {
      w.write('src/shared.ts', 'settings\npeople\n');
    });

    const [offered] = await sharedUnlanded(w.deps, {
      passId: w.opened.pass.id,
      taskId: w.settings.id,
    });
    expect(offered).toMatchObject({
      seq: first,
      dropRefusal: 'People: UI work changed `src/shared.ts` after it',
      laterPages: ['People: UI work'],
    });
    expect(await dropShared(w.deps, { passId: w.opened.pass.id, seq: first })).toMatchObject({
      dropSeq: null,
      refused: 'People: UI work changed `src/shared.ts` after it',
    });
    expect(read('src/shared.ts')).toBe('settings\npeople\n');
  });

  it("is refused while another page's turn holds the area", async () => {
    w = await openPassWorld();
    const seq = await sharedTurn(w.settings, () => {
      w.write('src/button.ts', 'a button\n');
    });
    w.startTurn(w.people);
    await grantSharedHold(w.deps, { workstreamId: w.runOf(w.people), area: 'src' });

    expect(await dropShared(w.deps, { passId: w.opened.pass.id, seq })).toMatchObject({
      dropSeq: null,
      refused: 'People: UI work holds src now',
    });
    expect(read('src/button.ts')).toBe('a button\n');
  });

  it('is refused for a file changed on disk since, and an Abandon leaves that file and names it', async () => {
    w = await openPassWorld();
    const seq = await sharedTurn(w.settings, () => {
      w.write('src/shared.ts', 'the agent\n');
      w.write('src/button.ts', 'a button\n');
    });
    w.write('src/shared.ts', "the agent\nand the builder's later edit\n");

    expect(await dropShared(w.deps, { passId: w.opened.pass.id, seq })).toMatchObject({
      refused: '`src/shared.ts` changed on disk since',
    });
    const forced = await dropShared(w.deps, { passId: w.opened.pass.id, seq, force: true });

    expect(forced).toMatchObject({ left: ['src/shared.ts'], refused: null });
    expect(read('src/shared.ts')).toBe("the agent\nand the builder's later edit\n");
    expect(existsSync(join(w.h.repo, 'src/button.ts'))).toBe(false);
  });
});

describe('a take-out that drops a shared change', () => {
  it('puts the change back with the page and leaves the pass', async () => {
    w = await openPassWorld();
    const seq = await sharedTurn(w.settings, () => {
      w.write('src/button.ts', 'a button\n');
    });

    const result = await takeOut(
      { ...w.deps, stopLane: () => Promise.resolve() },
      { taskId: w.settings.id, within: TakeOutWithin.Alone, shared: [{ seq, choice: 'drop' }] },
    );

    expect(result.tookOut).toBe(true);
    expect(existsSync(join(w.h.repo, 'src/button.ts'))).toBe(false);
    expect(listSharedChanges(w.h.store.db, w.opened.pass.id)[0]?.droppedBy).not.toBeNull();
    expect(getTask(w.h.store.db, w.settings.id).passId).toBeNull();
  });

  it('keeps a change whose file changed since it was chosen, and says why', async () => {
    w = await openPassWorld();
    const seq = await sharedTurn(w.settings, () => {
      w.write('src/button.ts', 'a button\n');
    });
    w.write('src/button.ts', 'a button the builder changed\n');

    await takeOut(
      { ...w.deps, stopLane: () => Promise.resolve() },
      { taskId: w.settings.id, within: TakeOutWithin.Alone, shared: [{ seq, choice: 'drop' }] },
    );

    expect(read('src/button.ts')).toBe('a button the builder changed\n');
    expect(listSharedChanges(w.h.store.db, w.opened.pass.id)[0]?.droppedBy).toBeNull();
    expect(listTaskThread(w.h.store.db, w.settings.id).map((m) => m.body)).toContain(
      `Shared change ${String(seq)} is kept on the chain: \`src/button.ts\` changed on disk since.`,
    );
  });
});
