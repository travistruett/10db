import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ConflictError,
  DecisionRule,
  type InboxItemDto,
  type NoticeDecision,
  type UndoAction,
} from '@10db/contracts';
import { getInboxItem, setRuleAsking } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { handMadeWorktreeFolders } from '../git';
import { PrState } from '../github';
import { createInboxService, type InboxService } from '../inbox';
import { WorktreeChoice } from './cards';
import { undoHandMadeRemoval } from './hand-made-undo';
import {
  HAND_MADE_IDLE_MS,
  mergedHandMadeWorktrees,
  offerHandMadeFolders,
  removeIdleMergedHandMade,
  removeMergedHandMade,
} from './hand-made-worktrees';
import { createWorktreeCardAnswers } from './index';

let h: DeliveryHarness;
let inbox: InboxService;
let folder: string;
/** What the process check answers: how many processes work in any worktree, or null when unreadable. */
let processes: number | null;
const signal = new AbortController().signal;

beforeEach(() => {
  processes = 0;
  h = createDeliveryHarness(
    { workspaceMode: 'worktree' },
    { trigger: false, processesIn: () => Promise.resolve(processes) },
  );
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

/** Sets the rule that removes merged worktrees to ask, so the look raises the card. */
function askBeforeRemoving(): void {
  h.state.write((c) => {
    setRuleAsking(c, h.project.id, DecisionRule.MergedWorktree, true);
  });
}

describe('the hand-made worktree folder', () => {
  beforeEach(askBeforeRemoving);

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

  it('keeps one card for the checkout, lists what has merged now, and withdraws it when none are left', async () => {
    const one = handMade('one', PrState.Merged);
    const two = handMade('two', PrState.Merged);
    await offerHandMadeFolders(h.ctx, signal);
    const card = cardTitled('2 worktrees in');
    expect(card.title).toBe(`2 worktrees in ${folder} have merged`);

    rmSync(one.path, { recursive: true, force: true });
    h.git$('worktree', 'prune');
    const three = handMade('three', PrState.Merged);
    await offerHandMadeFolders(h.ctx, signal);
    const [only, ...others] = h.cards().filter((c) => c.title.endsWith(' merged'));
    expect(others).toEqual([]);
    expect(only).toMatchObject({ id: card.id, title: `2 worktrees in ${folder} have merged` });
    expect(only?.body).toContain(two.path);
    expect(only?.body).toContain(three.path);
    expect(only?.body).not.toContain(one.path);

    writeFileSync(join(two.path, 'wip.txt'), 'x');
    writeFileSync(join(three.path, 'wip.txt'), 'x');
    await offerHandMadeFolders(h.ctx, signal);
    expect(offers()).toEqual([]);
    expect(getInboxItem(h.state.db, card.id)).toMatchObject({ state: 'CANCELLED' });
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

/** Sets every time a worktree is read by (its admin files, root and top-level entries) to `age` before now. */
function idleFor(path: string, age: number): void {
  const at = new Date(h.ctx.clock.now().getTime() - age);
  const gitDir = h.git$('-C', path, 'rev-parse', '--absolute-git-dir');
  for (const file of ['HEAD', 'index', join('logs', 'HEAD')])
    utimesSync(join(gitDir, file), at, at);
  for (const entry of readdirSync(path)) utimesSync(join(path, entry), at, at);
  utimesSync(path, at, at);
}

/** What the rule's one notice says Undo does. */
function undoOf(
  decision: NoticeDecision | undefined,
): Extract<UndoAction, { kind: 'restore_worktree' }> {
  if (decision?.undo.state !== 'undoable' || decision.undo.action.kind !== 'restore_worktree')
    throw new Error('the notice has no restore_worktree undo');
  return decision.undo.action;
}

const restore = (action: Extract<UndoAction, { kind: 'restore_worktree' }>): Promise<void> =>
  undoHandMadeRemoval({ state: h.state, git: h.git, keptRoot: h.keptRoot }, action);

describe('the rule that removes merged hand-made worktrees nobody is using', () => {
  beforeEach(() => {
    writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.env\n', { flag: 'a' });
  });

  it('removes a merged, clean worktree idle 24 hours with no process in it, saves its .env and keeps its branch, and Undo puts both back', async () => {
    const done = handMade('done', PrState.Merged);
    writeFileSync(join(done.path, '.env'), 'SECRET=1', { mode: 0o600 });

    idleFor(done.path, HAND_MADE_IDLE_MS - 60_000);
    await expect(removeIdleMergedHandMade(h.ctx, h.project, signal)).resolves.toEqual([]);
    expect(existsSync(done.path)).toBe(true);

    idleFor(done.path, HAND_MADE_IDLE_MS);
    processes = 1;
    await expect(removeIdleMergedHandMade(h.ctx, h.project, signal)).resolves.toEqual([]);
    processes = null;
    await expect(removeIdleMergedHandMade(h.ctx, h.project, signal)).resolves.toEqual([]);
    expect(existsSync(done.path)).toBe(true);
    expect(h.notices()).toEqual([]);

    processes = 0;
    await expect(removeIdleMergedHandMade(h.ctx, h.project, signal)).resolves.toEqual([done.path]);

    expect(existsSync(done.path)).toBe(false);
    expect(h.git$('branch', '--list', done.branch)).toContain(done.branch);
    const notice = h.only(h.notices());
    expect(notice.line).toBe('Removed the merged worktree done; its branch is kept');
    expect(notice.key).toBe(`hand-made-removed:${done.path}`);
    expect(notice.decision).toMatchObject({ by: 'rule', rule: DecisionRule.MergedWorktree });
    const action = undoOf(notice.decision);
    expect(action).toMatchObject({ path: done.path, branch: done.branch });
    const kept = action.keptDir ?? '';
    expect(kept.startsWith(h.keptRoot)).toBe(true);
    expect(readFileSync(join(kept, '.env'), 'utf8')).toBe('SECRET=1');

    await restore(action);

    expect(h.git$('-C', done.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(done.branch);
    expect(readFileSync(join(done.path, '.env'), 'utf8')).toBe('SECRET=1');
    expect(statSync(join(done.path, '.env')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(kept, '.env'))).toBe(true);
  });

  it('removes a worktree with nothing only it holds with no kept folder, and leaves what is not merged, changed, locked or kept', async () => {
    const plain = handMade('plain', PrState.Merged);
    const open = handMade('open', PrState.Open);
    const dirty = handMade('dirty', PrState.Merged);
    const locked = handMade('locked', PrState.Merged);
    writeFileSync(join(dirty.path, 'wip.txt'), 'x');
    h.git$('worktree', 'lock', locked.path);
    for (const w of [plain, open, dirty, locked]) idleFor(w.path, HAND_MADE_IDLE_MS + 1);

    await expect(removeIdleMergedHandMade(h.ctx, h.project, signal)).resolves.toEqual([plain.path]);

    expect([plain, open, dirty, locked].map((w) => existsSync(w.path))).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(undoOf(h.only(h.notices()).decision).keptDir).toBeNull();
  });

  it('answers a conflict and changes nothing when Undo finds the path taken or the branch gone', async () => {
    const done = handMade('done', PrState.Merged);
    idleFor(done.path, HAND_MADE_IDLE_MS);
    await removeIdleMergedHandMade(h.ctx, h.project, signal);
    const action = undoOf(h.only(h.notices()).decision);

    mkdirSync(done.path);
    writeFileSync(join(done.path, 'mine.txt'), 'not yours');
    await expect(restore(action)).rejects.toBeInstanceOf(ConflictError);
    expect(readdirSync(done.path)).toEqual(['mine.txt']);
    rmSync(done.path, { recursive: true });

    h.git$('branch', '-D', done.branch);
    await expect(restore(action)).rejects.toBeInstanceOf(ConflictError);
    expect(existsSync(done.path)).toBe(false);
    expect(h.git$('worktree', 'list', '--porcelain')).not.toContain(done.path);
  });

  it('is run by the look in the project’s queue, and raises and offers no card', async () => {
    const done = handMade('done', PrState.Merged);
    idleFor(done.path, HAND_MADE_IDLE_MS);

    await offerHandMadeFolders(h.ctx, signal);
    await h.jobs.idle();

    expect(existsSync(done.path)).toBe(false);
    expect(offers()).toEqual([]);
  });

  it('leaves it all to the card when the rule asks, which still leaves out a worktree holding a .env', async () => {
    const plain = handMade('plain', PrState.Merged);
    const holding = handMade('holding', PrState.Merged);
    writeFileSync(join(holding.path, '.env'), 'SECRET=1');
    for (const w of [plain, holding]) idleFor(w.path, HAND_MADE_IDLE_MS + 1);
    askBeforeRemoving();

    await expect(removeIdleMergedHandMade(h.ctx, h.project, signal)).resolves.toEqual([]);
    await offerHandMadeFolders(h.ctx, signal);
    await h.jobs.idle();
    expect(existsSync(plain.path)).toBe(true);
    expect(cardTitled('1 worktree in').body).toContain(plain.path);
    expect(cardTitled('1 worktree in').body).not.toContain(holding.path);

    await expect(mergedHandMadeWorktrees(h.ctx, h.project, signal)).resolves.toEqual([plain]);
    await removeMergedHandMade(h.ctx, h.project, signal);
    expect(existsSync(plain.path)).toBe(false);
    expect(existsSync(holding.path)).toBe(true);
    expect(existsSync(join(holding.path, '.env'))).toBe(true);
  });
});
