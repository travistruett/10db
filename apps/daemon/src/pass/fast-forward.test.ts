import { join } from 'node:path';
import { findOpenByFoldKey } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { branchMovedKey, fastForwardReturn } from './fast-forward';

// Workbench spec §5.4 (D8), §12: the close moves the folder's branch to the pass's tip by
// compare-and-swap and points HEAD back at it; each step is done only once, after a kill between any
// two, and a branch that moved or is in use elsewhere is never forced.

let w: PassWorld;
afterEach(() => {
  w.close();
});

/** The pass's branch with one signed-off commit on it; answers its tip. */
async function landedPass(): Promise<string> {
  w = await openPassWorld();
  return w.h.commit('src/settings/page.tsx', 'signed off\n');
}

const card = () =>
  findOpenByFoldKey(w.h.store.db, w.h.project.id, branchMovedKey(w.opened.pass.id));
const head = () => w.h.git$('symbolic-ref', '--short', 'HEAD');

describe('fastForwardReturn', () => {
  it.each([
    { name: 'from the start', before: (): void => undefined },
    {
      name: 'after a kill once the branch moved',
      before: (tip: string): void => {
        w.h.git$('update-ref', 'refs/heads/main', tip);
      },
    },
    {
      name: 'after a kill once HEAD was pointed',
      before: (tip: string): void => {
        w.h.git$('update-ref', 'refs/heads/main', tip);
        w.h.git$('symbolic-ref', 'HEAD', 'refs/heads/main');
      },
    },
  ])('moves the return branch to the tip and HEAD to it, $name', async ({ before }) => {
    const tip = await landedPass();
    before(tip);

    expect(await fastForwardReturn(w.deps, w.opened.pass)).toEqual({ kind: 'returned' });

    expect(w.h.git$('rev-parse', 'main')).toBe(tip);
    expect(head()).toBe('main');
    expect(w.h.git$('status', '--porcelain')).toBe('');
    expect(card()).toBeUndefined();
  });

  it('forces nothing when the return branch moved since the pass opened, and says how to merge', async () => {
    const tip = await landedPass();
    w.h.git$('branch', '-f', 'main', `${tip}~1`);
    const moved = w.h.git$('commit-tree', '-p', 'main', '-m', 'by hand', `${tip}^{tree}`);
    w.h.git$('update-ref', 'refs/heads/main', moved);

    expect(await fastForwardReturn(w.deps, w.opened.pass)).toEqual({ kind: 'moved' });

    expect(w.h.git$('rev-parse', 'main')).toBe(moved);
    expect(head()).toBe(w.branch);
    expect(card()?.detail).toMatchObject({
      kind: 'pass_branch_moved',
      reason: 'moved',
      mergeCommand: `git switch main && git merge ${w.branch}`,
    });
  });

  it("forces nothing when the pass's branch no longer holds where the pass started", async () => {
    const tip = await landedPass();
    // A hand-typed rewrite of the pass's branch drops the commit the pass started on.
    const rewritten = w.h.git$(
      'commit-tree',
      '-p',
      `${w.opened.pass.startSha}~1`,
      '-m',
      'by hand',
      `${tip}^{tree}`,
    );
    w.h.git$('update-ref', `refs/heads/${w.branch}`, rewritten);

    expect(await fastForwardReturn(w.deps, w.opened.pass)).toEqual({ kind: 'moved' });

    expect(w.h.git$('rev-parse', 'main')).toBe(w.opened.pass.startSha);
    expect(head()).toBe(w.branch);
    expect(card()?.body).toMatch(/no longer holds the commit the pass started on/);
  });

  it('forces nothing when the builder switched the folder back to the return branch by hand', async () => {
    const tip = await landedPass();
    w.h.git$('switch', '-q', 'main');

    expect(await fastForwardReturn(w.deps, w.opened.pass)).toEqual({ kind: 'moved' });

    expect(w.h.git$('rev-parse', 'main')).not.toBe(tip);
    expect(card()?.detail).toMatchObject({ reason: 'moved' });
  });

  it('forces nothing while the return branch is checked out in another worktree', async () => {
    const tip = await landedPass();
    const other = join(w.h.dataDir, 'other-worktree');
    w.h.git$('worktree', 'add', '-q', other, 'main');

    expect(await fastForwardReturn(w.deps, w.opened.pass)).toMatchObject({ kind: 'in_use' });

    expect(w.h.git$('rev-parse', 'main')).not.toBe(tip);
    expect(head()).toBe(w.branch);
    expect(card()?.detail).toMatchObject({ reason: 'in_use_elsewhere' });
  });
});
