import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxItemDto } from '@10db/contracts';
import { getInboxItem } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { handMadeWorktreeFolders } from '../git';
import { PrState } from '../github';
import { createInboxService, type InboxService } from '../inbox';
import { WorktreeChoice } from './cards';
import { offerHandMadeFolders } from './hand-made-worktrees';
import { createWorktreeCardAnswers } from './index';

let h: DeliveryHarness;
let inbox: InboxService;
let folder: string;
const signal = new AbortController().signal;

beforeEach(() => {
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
  inbox = createInboxService({
    state: h.state,
    onParkedAnswer: () => undefined,
    onFlagAnswer: createWorktreeCardAnswers(h.ctx, {
      starter: h.starter,
      abandon: (id) => h.shipper.abandon(id),
    }),
  });
  folder = handMadeWorktreeFolders(h.repo)[1] ?? '';
  mkdirSync(folder, { recursive: true });
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  h.close();
});

/** A worktree made by hand on its own branch, whose pull request is in `state` at the branch's tip. */
function handMade(name: string, state: PrState): { path: string; branch: string } {
  const branch = `hand/${name}`;
  const path = join(folder, name);
  h.git$('worktree', 'add', '-b', branch, path, 'main');
  const url = h.gh.openPr(branch, state);
  h.gh.setHead(url, h.git$('rev-parse', branch));
  return { path, branch };
}

const titles = (): string[] => h.cards().map((c) => c.title);
/** The titles of the open cards that offer merged worktrees for removal. */
const offers = (): string[] => titles().filter((t) => t.endsWith(' merged'));
const cardTitled = (start: string): InboxItemDto => {
  const found = h.cards().find((c) => c.title.startsWith(start));
  if (!found) throw new Error(`no card starts with ${start}: ${titles().join(' | ')}`);
  return found;
};

describe('the hand-made worktree folder', () => {
  it('offers the merged worktrees for removal and removes them on one answer, leaving the branches', async () => {
    const merged = handMade('done', PrState.Merged);
    const open = handMade('going', PrState.Open);
    await offerHandMadeFolders(h.ctx, signal);

    expect(cardTitled('Spotlight indexes').body).toContain('-worktrees.noindex');
    const card = cardTitled('1 worktree in');
    expect(card.options.map((o) => o.label)).toEqual([
      WorktreeChoice.RemoveMerged,
      WorktreeChoice.Keep,
    ]);
    expect(card.body).toContain(merged.path);
    expect(card.body).not.toContain(open.path);

    inbox.answer(card.id, { choice: WorktreeChoice.RemoveMerged });
    await h.jobs.idle();

    expect(existsSync(merged.path)).toBe(false);
    expect(existsSync(open.path)).toBe(true);
    expect(h.git$('branch', '--list', merged.branch)).toContain(merged.branch);
    const removed = h.only(h.notices());
    expect(removed.line).toBe('Removed 1 merged worktree from ' + folder);
    expect(removed.body).toContain(merged.path);
    expect(removed.key).toBe(`hand-made-removed:${folder}`);
    expect(titles().filter((t) => t.startsWith('Removed'))).toEqual([]);
  });

  it('offers merged worktrees in the .noindex folder, and offers no Spotlight card for it', async () => {
    rmSync(folder, { recursive: true, force: true });
    const noindex = handMadeWorktreeFolders(h.repo)[0] ?? '';
    mkdirSync(noindex, { recursive: true });
    const branch = 'hand/done';
    const path = join(noindex, 'done');
    h.git$('worktree', 'add', '-b', branch, path, 'main');
    h.gh.setHead(h.gh.openPr(branch, PrState.Merged), h.git$('rev-parse', branch));
    try {
      await offerHandMadeFolders(h.ctx, signal);
      expect(cardTitled('1 worktree in').body).toContain(path);
      expect(titles().filter((t) => t.startsWith('Spotlight indexes'))).toEqual([]);
    } finally {
      rmSync(noindex, { recursive: true, force: true });
    }
  });

  it('closes its offer by itself once none of the worktrees it names exists, but not while one does', async () => {
    const one = handMade('one', PrState.Merged);
    const two = handMade('two', PrState.Merged);
    await offerHandMadeFolders(h.ctx, signal);
    const card = cardTitled('2 worktrees in');

    rmSync(one.path, { recursive: true, force: true });
    h.git$('worktree', 'prune');
    await offerHandMadeFolders(h.ctx, signal);
    expect(h.cards().some((c) => c.id === card.id)).toBe(true);

    rmSync(two.path, { recursive: true, force: true });
    h.git$('worktree', 'prune');
    await offerHandMadeFolders(h.ctx, signal);
    expect(h.cards().some((c) => c.id === card.id)).toBe(false);
    expect(getInboxItem(h.state.db, card.id)).toMatchObject({ state: 'RESOLVED' });
  });

  const stays: readonly { name: string; hold: (path: string) => void }[] = [
    {
      name: 'it has an uncommitted change',
      hold: (p) => {
        writeFileSync(join(p, 'wip.txt'), 'x');
      },
    },
    {
      name: 'it holds a loose git-ignored file',
      hold: (p) => {
        writeFileSync(join(p, '.env'), 'k');
      },
    },
    {
      name: 'the builder locked it',
      hold: (p) => {
        h.git$('worktree', 'lock', p);
      },
    },
  ];
  for (const { name, hold } of stays)
    it(`leaves a merged worktree out of the offer when ${name}`, async () => {
      writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.env\n', { flag: 'a' });
      const kept = handMade('kept', PrState.Merged);
      hold(kept.path);
      await offerHandMadeFolders(h.ctx, signal);
      expect(offers()).toEqual([]);
      expect(existsSync(kept.path)).toBe(true);
    });

  it('does not offer a worktree whose branch holds a commit the merged pull request lacks', async () => {
    const ahead = handMade('ahead', PrState.Merged);
    h.git$('-C', ahead.path, 'commit', '--allow-empty', '-q', '-m', 'after the merge');
    await offerHandMadeFolders(h.ctx, signal);
    expect(offers()).toEqual([]);
  });

  it('does not offer the same worktrees again once the builder answered Keep, but offers a new one', async () => {
    handMade('one', PrState.Merged);
    await offerHandMadeFolders(h.ctx, signal);
    inbox.answer(cardTitled('1 worktree in').id, { choice: WorktreeChoice.Keep });
    await offerHandMadeFolders(h.ctx, signal);
    expect(offers()).toEqual([]);

    handMade('two', PrState.Merged);
    await offerHandMadeFolders(h.ctx, signal);
    expect(cardTitled('2 worktrees in').body).toContain('two');
  });

  it('removes nothing the answer finds changed since the offer', async () => {
    const worktree = handMade('late', PrState.Merged);
    await offerHandMadeFolders(h.ctx, signal);
    writeFileSync(join(worktree.path, 'wip.txt'), 'x');
    inbox.answer(cardTitled('1 worktree in').id, { choice: WorktreeChoice.RemoveMerged });
    await h.jobs.idle();
    expect(existsSync(worktree.path)).toBe(true);
    expect(h.only(h.notices()).body).toContain('Nothing was removed');
    expect(titles().filter((t) => t.startsWith('Removed'))).toEqual([]);
  });
});
