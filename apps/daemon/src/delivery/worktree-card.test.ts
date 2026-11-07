import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InboxItemDto } from '@10db/contracts';
import { clearWorktreePath, getBatch, getBatchRow } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { opened, pathOf } from '../../test/delivery-worlds';
import { comparablePath, samePath } from '../git';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import { systemProcesses } from '../recovery';
import { checkoutCards, CheckoutChoice, startCards, WorktreeChoice, worktreeCards } from './cards';
import { createWorktreeCardAnswers, recoverBatches } from './index';
import { raise } from './context';

let h: DeliveryHarness;
let inbox: InboxService;
function build(workspaceMode: 'worktree' | 'shared'): void {
  h = createDeliveryHarness({ workspaceMode }, { trigger: false });
  inbox = createInboxService({
    state: h.state,
    onParkedAnswer: () => undefined,
    onFlagAnswer: createWorktreeCardAnswers(h.ctx, {
      starter: h.starter,
      abandon: (id) => h.shipper.abandon(id),
    }),
  });
}
afterEach(() => {
  h.close();
});

const labels = (card: InboxItemDto): string[] => card.options.map((o) => o.label);

const recover = () =>
  recoverBatches({
    state: h.state,
    git: h.git,
    inbox: h.inbox,
    processes: systemProcesses,
    shipper: h.shipper,
    starter: h.starter,
    logger: silentLogger,
    worktrees: { ctx: h.ctx, root: h.worktreeRoot },
  });

describe('a batch whose worktree is missing', () => {
  beforeEach(() => {
    build('worktree');
  });

  it('offers Retry and Abandon batch once it failed, and Retry makes the worktree again', async () => {
    const { batch } = await opened(h);
    const path = pathOf(batch);
    rmSync(path, { recursive: true, force: true });
    await recover();
    const card = h.only(h.cards());
    expect(labels(card)).toEqual([WorktreeChoice.Retry, WorktreeChoice.Abandon]);
    expect(getBatch(h.store.db, batch.id).state).toBe('FAILED');

    inbox.answer(card.id, { choice: WorktreeChoice.Retry });
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    expect(existsSync(path)).toBe(true);
    expect(h.cards()).toEqual([]);
  });

  it('abandons the batch on Abandon batch', async () => {
    const { batch } = await opened(h);
    const path = pathOf(batch);
    rmSync(path, { recursive: true, force: true });
    await recover();
    const card = h.only(h.cards());

    inbox.answer(card.id, { choice: WorktreeChoice.Abandon });
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id).state).toBe('ABANDONED');
  });

  it('offers Abandon batch alone while the open batch waits, and does it', async () => {
    const { batch } = await opened(h);
    const path = pathOf(batch);
    const card = worktreeCards.missing(batch, path, 'waits');
    raise(h.inbox, batch.projectId, card);
    const raised = h.only(h.cards());
    expect(labels(raised)).toEqual([WorktreeChoice.Abandon]);

    inbox.answer(raised.id, { choice: WorktreeChoice.Abandon });
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id).state).toBe('ABANDONED');
  });

  it('closes the card without acting when the batch has moved on since', async () => {
    const { batch } = await opened(h);
    const path = pathOf(batch);
    raise(h.inbox, batch.projectId, worktreeCards.missing(batch, path, 'waits'));
    const raised = h.only(h.cards());
    h.shipper.abandon(batch.id);
    await h.jobs.idle();

    inbox.answer(raised.id, { choice: WorktreeChoice.Abandon });
    await h.jobs.idle();

    // Abandoning an empty branch leaves its own notice that the branch was deleted; the worktree card is gone.
    expect(h.cards().map((c) => c.title)).toEqual([
      `Batch "${batch.title}" abandoned: ${batch.branch ?? ''} deleted`,
    ]);
  });
});

describe('a worktree 10db kept', () => {
  beforeEach(() => {
    build('worktree');
  });

  /** Abandons a batch whose worktree holds an uncommitted file, so 10db keeps the worktree. */
  async function keptDirty() {
    const { batch } = await opened(h);
    const path = pathOf(batch);
    writeFileSync(join(path, 'notes.txt'), 'not committed\n');
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    const card = h.cards().find((c) => c.title.includes('uncommitted changes kept'));
    if (!card) throw new Error('no kept-dirty worktree card');
    return { batch, path, card };
  }

  it('offers Remove worktree and Keep, and Remove worktree removes it with its changes', async () => {
    const { batch, path, card } = await keptDirty();
    expect(labels(card)).toEqual([WorktreeChoice.Remove, WorktreeChoice.Keep]);

    inbox.answer(card.id, { choice: WorktreeChoice.Remove });
    await h.jobs.idle();

    expect(existsSync(path)).toBe(false);
    expect(getBatch(h.store.db, batch.id).worktreePath).toBeNull();
    expect(h.cards().filter((c) => c.title.includes('uncommitted changes kept'))).toEqual([]);
  });

  it('leaves the worktree on Keep', async () => {
    const { batch, path, card } = await keptDirty();

    inbox.answer(card.id, { choice: WorktreeChoice.Keep });
    await h.jobs.idle();

    expect(existsSync(join(path, 'notes.txt'))).toBe(true);
    expect(getBatch(h.store.db, batch.id).worktreePath).toBe(path);
  });

  it('removes a closed batch worktree that holds a hand-made .env on Remove worktree', async () => {
    const { batch } = await opened(h);
    const path = pathOf(batch);
    writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.env\n');
    writeFileSync(join(path, '.env'), 'mine\n');
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    const card = h.only(h.cards().filter((c) => c.title.includes('git-ignored')));
    expect(labels(card)).toEqual([WorktreeChoice.Remove, WorktreeChoice.Keep]);

    inbox.answer(card.id, { choice: WorktreeChoice.Remove });
    await h.jobs.idle();

    expect(existsSync(path)).toBe(false);
  });
});

describe('a worktree no batch uses any more', () => {
  beforeEach(() => {
    build('worktree');
  });

  /** Opens a batch, then clears its worktree path so its locked worktree is an orphan. */
  async function orphaned() {
    const { batch } = await opened(h);
    const path = pathOf(batch);
    h.state.write((c) => {
      clearWorktreePath(c, batch.id);
    });
    return { batch, path };
  }

  const listed = async (path: string): Promise<boolean> =>
    (await h.git.listWorktrees(h.repo)).some((e) => samePath(comparablePath(e.path), path));

  it('removes it with its changes and withdraws its cards on Remove worktree', async () => {
    const { batch, path } = await orphaned();
    writeFileSync(join(path, 'notes.txt'), 'not committed\n');
    raise(h.inbox, batch.projectId, worktreeCards.orphanKept(h.repo, path, ['notes.txt'], []));
    const card = h.only(h.cards());
    expect(labels(card)).toEqual([WorktreeChoice.Remove, WorktreeChoice.Keep]);

    inbox.answer(card.id, { choice: WorktreeChoice.Remove });
    await h.jobs.idle();

    expect(existsSync(path)).toBe(false);
    expect(await listed(path)).toBe(false);
    expect(h.cards()).toEqual([]);
  });

  it('says nothing was removed, and why, when a batch holds the worktree again', async () => {
    const { batch } = await opened(h);
    const path = pathOf(batch);
    raise(h.inbox, batch.projectId, worktreeCards.orphanKept(h.repo, path, ['notes.txt'], []));
    const card = h.only(h.cards());

    inbox.answer(card.id, { choice: WorktreeChoice.Remove });
    await h.jobs.idle();

    expect(existsSync(path)).toBe(true);
    expect(await listed(path)).toBe(true);
    const notice = h.only(h.cards());
    expect(notice.id).not.toBe(card.id);
    expect(notice.title).toBe(`10db removed nothing at ${path}`);
    expect(notice.body).toContain('a batch uses it');
  });

  it('says nothing was removed when git no longer lists the path', async () => {
    const { batch, path } = await orphaned();
    raise(h.inbox, batch.projectId, worktreeCards.orphanKept(h.repo, path, ['notes.txt'], []));
    const card = h.only(h.cards());
    h.git$('worktree', 'unlock', path);
    h.git$('worktree', 'remove', '--force', path);

    inbox.answer(card.id, { choice: WorktreeChoice.Remove });
    await h.jobs.idle();

    const notice = h.only(h.cards());
    expect(notice.title).toBe(`10db removed nothing at ${path}`);
    expect(notice.body).toContain('git no longer lists');
  });

  it('says nothing was removed, and why, when 10db no longer has the worktree locked', async () => {
    const { batch, path } = await orphaned();
    raise(h.inbox, batch.projectId, worktreeCards.orphanKept(h.repo, path, ['notes.txt'], []));
    const card = h.only(h.cards());
    h.git$('worktree', 'unlock', path);

    inbox.answer(card.id, { choice: WorktreeChoice.Remove });
    await h.jobs.idle();

    expect(existsSync(path)).toBe(true);
    expect(await listed(path)).toBe(true);
    const notice = h.only(h.cards());
    expect(notice.id).not.toBe(card.id);
    expect(notice.title).toBe(`10db removed nothing at ${path}`);
    expect(notice.body).toContain('10db no longer has it locked');
  });
});

describe('a directory 10db left in place', () => {
  beforeEach(() => {
    build('worktree');
  });

  it('deletes it on Delete directory', async () => {
    const { batch } = await opened(h);
    const dir = join(h.worktreeRoot, 'widgets-0a1b2c', 'stray');
    mkdirSync(join(dir, 'inner'), { recursive: true });
    writeFileSync(join(dir, 'inner', 'a.txt'), 'x\n');
    raise(h.inbox, batch.projectId, worktreeCards.leftBehind(batch, dir));
    const card = h.only(h.cards());
    expect(labels(card)).toEqual([WorktreeChoice.Delete, WorktreeChoice.Keep]);

    inbox.answer(card.id, { choice: WorktreeChoice.Delete });
    await h.jobs.idle();

    expect(existsSync(dir)).toBe(false);
    expect(h.cards()).toEqual([]);
  });

  it('refuses a directory outside the worktree root, and raises a card saying so', async () => {
    const { batch } = await opened(h);
    const dir = join(dirname(h.repo), 'not-ours');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    raise(h.inbox, batch.projectId, worktreeCards.leftBehind(batch, dir));
    const card = h.only(h.cards());

    inbox.answer(card.id, { choice: WorktreeChoice.Delete });
    await h.jobs.idle();

    expect(existsSync(join(dir, 'a.txt'))).toBe(true);
    const again = h.only(h.cards());
    expect(again.title).toBe(`10db could not remove ${dir}`);
    expect(labels(again)).toEqual([WorktreeChoice.Delete, WorktreeChoice.Keep]);
  });
});

describe('a checkout left on the batch branch', () => {
  beforeEach(() => {
    build('shared');
  });

  /** Ends a batch with an uncommitted file in the checkout, so 10db leaves it on the batch's branch. */
  async function leftDirty() {
    const started = h.only(
      h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [h.addTask('Alpha').id] }),
    );
    await h.jobs.idle();
    writeFileSync(join(h.repo, 'notes.txt'), 'mine\n');
    h.shipper.abandon(started.id);
    await h.jobs.idle();
    const card = h.only(h.cards().filter((c) => c.title.startsWith('Your checkout')));
    return { batch: getBatch(h.store.db, started.id), card };
  }

  it('offers Switch back and Leave it, and Switch back tries again once it is clean', async () => {
    const { batch, card } = await leftDirty();
    expect(labels(card)).toEqual([CheckoutChoice.SwitchBack, CheckoutChoice.Leave]);
    expect(h.git$('branch', '--show-current')).toBe(batch.branch);

    rmSync(join(h.repo, 'notes.txt'));
    inbox.answer(card.id, { choice: CheckoutChoice.SwitchBack });
    await h.jobs.idle();

    expect(h.git$('branch', '--show-current')).toBe('main');
    expect(h.cards().filter((c) => c.title.startsWith('Your checkout'))).toEqual([]);
    expect(getBatchRow(h.store.db, batch.id)).toMatchObject({
      returnBranch: null,
      returnSha: null,
    });
  });

  it('raises a new card when something is still in the way', async () => {
    const { batch, card } = await leftDirty();

    inbox.answer(card.id, { choice: CheckoutChoice.SwitchBack });
    await h.jobs.idle();

    expect(h.git$('branch', '--show-current')).toBe(batch.branch);
    const again = h.only(h.cards().filter((c) => c.title.startsWith('Your checkout')));
    expect(again.id).not.toBe(card.id);
    expect(labels(again)).toEqual([CheckoutChoice.SwitchBack, CheckoutChoice.Leave]);
  });

  it('leaves the checkout on Leave it', async () => {
    const { batch, card } = await leftDirty();

    inbox.answer(card.id, { choice: CheckoutChoice.Leave });
    await h.jobs.idle();

    expect(h.git$('branch', '--show-current')).toBe(batch.branch);
    expect(h.cards().filter((c) => c.title.startsWith('Your checkout'))).toEqual([]);
  });

  it('offers the base branch when the place it came from is gone, and switches to it', async () => {
    const { batch, card: dirty } = await leftDirty();
    // The dirty card is answered first, so this one is a card of its own rather than folded into it.
    inbox.answer(dirty.id, { choice: CheckoutChoice.Leave });
    const project = h.project;
    const gone = checkoutCards.gone(batch, project, {
      branch: 'deleted-branch',
      sha: 'a'.repeat(40),
    });
    expect(gone.options?.map((o) => o.label)).toEqual([
      CheckoutChoice.SwitchBase,
      CheckoutChoice.Leave,
    ]);
    // The base branch is where the checkout can go; raise the card for the batch as returnCheckout would.
    rmSync(join(h.repo, 'notes.txt'));
    raise(h.inbox, batch.projectId, gone);
    const card = h.only(h.cards().filter((c) => c.title.includes('no longer exists')));

    inbox.answer(card.id, { choice: CheckoutChoice.SwitchBase });
    await h.jobs.idle();

    expect(h.git$('branch', '--show-current')).toBe(batch.baseBranch);
  });
});

describe('every worktree and checkout card', () => {
  it('offers an answer beyond a bare dismiss', async () => {
    build('worktree');
    const { batch } = await opened(h);
    const path = pathOf(batch);
    const place = { branch: 'main', sha: 'b'.repeat(40) };
    const project = h.project;
    const cards = [
      worktreeCards.missing(batch, path, 'waits'),
      worktreeCards.missing(batch, path, 'failed'),
      worktreeCards.keptDirty(batch, h.repo, path, ['a.txt'], []),
      worktreeCards.keptIgnored(batch, h.repo, path, ['.env']),
      worktreeCards.keptIgnored(batch, h.repo, path, null),
      worktreeCards.orphanKept(h.repo, path, ['a.txt'], []),
      worktreeCards.orphanIgnored(h.repo, path, ['.env']),
      worktreeCards.leftBehind(batch, path),
      worktreeCards.inTheWay(batch, path, 'why'),
      worktreeCards.notReopened(batch, new Error('no')),
      worktreeCards.notWhole(batch, path, 'elsewhere', ['a.txt']),
      worktreeCards.removeFailed({ kind: 'orphan', path }, path, new Error('no')),
      checkoutCards.dirty(batch, project, place, ['a.txt']),
      checkoutCards.ignored(batch, project, place, ['a.txt']),
      checkoutCards.checkedOut(batch, place, path),
      checkoutCards.gone(batch, project, place),
      checkoutCards.lanesRunning(batch, project, place, 2),
      checkoutCards.failed(batch, project, place, new Error('no')),
    ];
    for (const card of cards) {
      const options = card.options ?? [];
      expect(options.length, card.title).toBeGreaterThan(0);
      // An answer the daemon acts on, not only Keep or Leave it.
      expect(
        options.some((o) => o.label !== WorktreeChoice.Keep && o.label !== CheckoutChoice.Leave),
        card.title,
      ).toBe(true);
      expect(
        options.every((o) => o.description.length > 0),
        card.title,
      ).toBe(true);
    }
  });

  it('the lanes-running cards name lanes in Your folder as what blocks a switch', async () => {
    build('worktree');
    const { batch } = await opened(h);
    const place = { branch: 'main', sha: 'b'.repeat(40) };
    const bodies = [
      startCards.lanesRunning(h.project, 3).body,
      checkoutCards.lanesRunning(batch, h.project, place, 3).body,
    ];
    for (const body of bodies) {
      expect(body).toContain('Your folder');
      expect(body).toContain('separate cop');
      expect(body).toContain('3');
      expect(body).not.toMatch(/no (lane|work) runs in the project/);
    }
  });
});
