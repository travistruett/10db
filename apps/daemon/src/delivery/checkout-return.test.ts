import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  EventType,
  mintId,
  type BatchDto,
} from '@10db/contracts';
import {
  getBatch,
  getBatchRow,
  insertChat,
  insertConversation,
  insertWorkstream,
  listWorkstreams,
  schema,
  transitionBatch,
} from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { tempDir, waitForAsync } from '../../test/fixtures';
import { silentLogger } from '../log';
import { systemProcesses } from '../recovery';
import { recoverBatches } from './index';

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

type End = 'SHIPPED' | 'CLOSED' | 'ABANDONED';
const ENDS: readonly End[] = ['SHIPPED', 'CLOSED', 'ABANDONED'];

/** Where the builder's checkout is: its branch ('' when detached), its commit and its status. */
function where() {
  return {
    branch: h.git$('branch', '--show-current'),
    head: h.git$('rev-parse', 'HEAD'),
    status: h.git$('status', '--porcelain'),
  };
}

/**
 * Opens a batch of one task. A batch that is to ship gets a commit on its branch; one that is to
 * close gets none.
 */
async function openBatch(end: End): Promise<BatchDto> {
  const task = h.addTask('Alpha');
  const started = h.only(
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] }),
  );
  await h.jobs.idle();
  if (end === 'SHIPPED') h.commit('src/api/alpha.txt');
  return getBatch(h.store.db, started.id);
}

/** Ends the batch the way the daemon does: the ship trigger ships or closes it, Abandon abandons it. */
async function endLive(batch: BatchDto, end: End): Promise<BatchDto> {
  if (end === 'ABANDONED') h.shipper.abandon(batch.id);
  else for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

/** The pull requests endedWhileDown has recorded, so each shipped batch gets its own. */
let prs = 0;

/** Records the end with no switch back, as a daemon that stopped right after the record leaves it. */
function endedWhileDown(batch: BatchDto, end: End): void {
  for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
  h.state.write((c) => {
    if (end === 'ABANDONED') transitionBatch(c, batch.id, { to: 'ABANDONED' });
    else {
      transitionBatch(c, batch.id, { to: 'SHIPPING' });
      transitionBatch(c, batch.id, {
        to: end,
        ...(end === 'SHIPPED'
          ? { patch: { prUrl: `https://github.com/acme/widgets/pull/${String((prs += 1))}` } }
          : {}),
      });
    }
  });
}

const recover = () =>
  recoverBatches({
    folderHold: h.ctx.folderHold,
    jobs: h.jobs,
    state: h.state,
    git: h.git,
    inbox: h.inbox,
    processes: systemProcesses,
    shipper: h.shipper,
    starter: h.starter,
    logger: silentLogger,
  });

/** A chat of the project the builder has taken to the terminal; returns its conversation. */
function inTheTerminal() {
  return h.state.write((ctx) => {
    const id = mintId('Chat');
    const conv = insertConversation(ctx, {
      projectId: h.project.id,
      owner: { kind: ConversationOwnerKind.Chat, id },
      profile: ConversationProfile.Explore,
      state: ConversationState.TakenOver,
    });
    insertChat(ctx, {
      id,
      projectId: h.project.id,
      conversationId: conv.id,
      title: 'In terminal',
      tabPosition: 0,
    });
    return conv.id;
  });
}

/** The checkout states a batch can end in, and what 10db then does with it. */
const CHECKOUTS: readonly {
  readonly name: string;
  /** Before the batch starts: where 10db finds the checkout. */
  readonly before?: () => void;
  /** After the batch's work, before it ends. */
  readonly arrange?: (batch: BatchDto) => void;
  /** Where HEAD ends: where the cut found it, on the batch's branch, or on the builder's own. */
  readonly ends: 'start' | 'batch' | 'elsewhere';
  /** The card's title, when 10db says why it left the checkout. */
  readonly card?: RegExp;
}[] = [
  { name: 'clean on the batch branch', ends: 'start' },
  {
    name: 'clean on the batch branch, switched from a detached HEAD',
    before: () => {
      h.git$('checkout', '-q', '--detach', 'main');
    },
    ends: 'start',
  },
  {
    name: 'with uncommitted changes',
    arrange: () => {
      writeFileSync(join(h.repo, 'notes.txt'), 'mine\n');
    },
    ends: 'batch',
    card: /^Your checkout stays on 10db\/greetings-[0-9a-f]{8}: it has uncommitted changes$/,
  },
  {
    name: 'moved to another branch by the builder',
    arrange: () => {
      h.git$('switch', '-q', '-c', 'elsewhere');
    },
    ends: 'elsewhere',
  },
];

/** Asserts, labelled with `label`, where the checkout ended and which card, if any, said why. */
function expectCheckout(
  batch: BatchDto,
  start: { readonly branch: string; readonly head: string },
  row: (typeof CHECKOUTS)[number],
  label: string,
): void {
  const now = where();
  switch (row.ends) {
    case 'start':
      expect.soft(now, label).toEqual({ ...start, status: '' });
      break;
    case 'batch':
      expect.soft(now.branch, label).toBe(batch.branch);
      break;
    case 'elsewhere':
      expect.soft(now.branch, label).toBe('elsewhere');
  }
  const cards = h.cards().filter((card) => card.title.startsWith('Your checkout'));
  if (row.card) {
    expect.soft(cards, label).toHaveLength(1);
    for (const card of cards) {
      expect.soft(card.title, label).toMatch(row.card);
      expect.soft(card.body, label).toContain('- notes.txt');
      expect.soft(card.body, label).toContain(`git -C '${h.repo}' switch 'main'`);
    }
  } else expect.soft(cards, label).toEqual([]);
  // Done or declined, the place is forgotten, so a restart doesn't switch the checkout again.
  expect
    .soft(getBatchRow(h.store.db, batch.id), label)
    .toMatchObject({ returnBranch: null, returnSha: null });
}

/** The rows a repository of their own must run: those that leave the checkout off where it started. */
const leavesTheCheckout = (row: (typeof CHECKOUTS)[number]) => row.ends === 'batch';

/** Rows in the order one repository can run them: those that start from a branch first. */
const fromABranchFirst = <T extends (typeof CHECKOUTS)[number]>(rows: T[]): T[] => [
  ...rows.filter((row) => !row.before),
  ...rows.filter((row) => row.before),
];

describe('the cut', () => {
  it('records where it found the checkout, a branch and its commit or a detached commit, and nothing for a worktree batch, which never touches the checkout', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const main = h.git$('rev-parse', 'HEAD');
    const batch = await openBatch('CLOSED');
    expect(getBatchRow(h.store.db, batch.id)).toMatchObject({
      returnBranch: 'main',
      returnSha: main,
    });
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    h.git$('checkout', '-q', '--detach', 'main');
    const detached = await openBatch('CLOSED');
    expect(getBatchRow(h.store.db, detached.id)).toMatchObject({
      returnBranch: null,
      returnSha: main,
    });

    h.close();
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const copy = await openBatch('CLOSED');
    expect(getBatchRow(h.store.db, copy.id)).toMatchObject({
      returnBranch: null,
      returnSha: null,
    });
  });
});

/** Moves the checkout back to main after a row that left it on the builder's own branch. */
function backFromElsewhere(): void {
  h.git$('switch', '-q', 'main');
  h.git$('branch', '-D', 'elsewhere');
}

describe('when a batch ends', () => {
  const live = ENDS.flatMap((end) =>
    CHECKOUTS.filter(
      // Shipping checks the branch and a clean checkout first, so only Abandon ends a batch whose
      // checkout is dirty or moved while the daemon runs.
      (row) => end === 'ABANDONED' || row.ends === 'start',
    ).map((row) => ({ ...row, end, title: `${end}, ${row.name}` })),
  );

  it('switches the checkout back to where the cut found it when a batch ships, closes or is abandoned, keeping shipped work on its branch and on origin, and leaves it where an abandoned batch finds it dirty or moved', async () => {
    // Rows that put the checkout back, or leave it on the builder's own branch, share one
    // repository; a row that leaves it dirty on the batch branch gets its own.
    h = createDeliveryHarness();
    const shared = fromABranchFirst(live.filter((row) => !leavesTheCheckout(row)));
    const apart = live.filter(leavesTheCheckout);
    for (const row of [...shared, ...apart]) {
      if (apart.includes(row)) {
        h.close();
        h = createDeliveryHarness();
      }
      row.before?.();
      const start = where();
      const batch = await openBatch(row.end);
      expect.soft(where().branch, row.title).toBe(batch.branch);
      const tip = h.git$('rev-parse', 'HEAD');
      row.arrange?.(batch);
      const ended = await endLive(batch, row.end);
      expect.soft(ended.state, row.title).toBe(row.end);
      expectCheckout(batch, start, row, row.title);
      if (row.end === 'SHIPPED') {
        expect.soft(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`), row.title).toBe(tip);
        expect
          .soft(h.origin$('rev-parse', `refs/heads/${batch.branch ?? ''}`), row.title)
          .toBe(tip);
      }
      if (row.ends === 'elsewhere') backFromElsewhere();
    }
  });

  it('leaves the checkout and says so when the branch it came from was deleted', async () => {
    h = createDeliveryHarness();
    const batch = await openBatch('ABANDONED');
    h.git$('branch', '-D', 'main');
    await endLive(batch, 'ABANDONED');
    expect(where().branch).toBe(batch.branch);
    const card = h.only(h.cards().filter((c) => c.title.startsWith('Your checkout')));
    expect(card.title).toBe(`Your checkout stays on ${batch.branch ?? ''}: main no longer exists`);
    expect(card.detail).toMatchObject({ batchId: batch.id });
  });
});

describe('a batch that ended while the daemon was down', () => {
  const matrix = ENDS.flatMap((end) =>
    CHECKOUTS.map((row) => ({ ...row, end, title: `${end}, ${row.name}` })),
  );

  it('startup recovery acts as the end would have, for every end and checkout, and unwinds batches that ended one after another back to where the first found the checkout', async () => {
    h = createDeliveryHarness({}, { trigger: false });

    // Unwinding: the next batch is cut while the checkout is still on the first one's branch.
    const home = where();
    const first = await openBatch('CLOSED');
    endedWhileDown(first, 'CLOSED');
    const second = await openBatch('CLOSED');
    expect(getBatchRow(h.store.db, second.id).returnBranch).toBe(first.branch);
    endedWhileDown(second, 'CLOSED');
    expect((await recover()).switchedBack).toEqual([second.id, first.id]);
    expect(where()).toEqual({ ...home, status: '' });

    // Rows that put the checkout back, or leave it on the builder's own branch, share this
    // repository; a row that leaves it dirty on the batch branch gets its own.
    const shared = fromABranchFirst(matrix.filter((row) => !leavesTheCheckout(row)));
    const apart = matrix.filter(leavesTheCheckout);
    for (const row of [...shared, ...apart]) {
      if (apart.includes(row)) {
        h.close();
        h = createDeliveryHarness({}, { trigger: false });
      }
      row.before?.();
      const start = where();
      const batch = await openBatch(row.end);
      row.arrange?.(batch);
      endedWhileDown(batch, row.end);
      await recover();
      expectCheckout(batch, start, row, row.title);
      // A second start finds nothing left to do.
      await recover();
      expectCheckout(batch, start, row, `${row.title}, a second start`);
      if (row.ends === 'elsewhere') backFromElsewhere();
    }
  });

  it('leaves the checkout with a card when git refuses it, and does not try again', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const batch = await openBatch('CLOSED');
    endedWhileDown(batch, 'CLOSED');
    const alternates = join(h.repo, '.git', 'objects', 'info', 'alternates');
    writeFileSync(alternates, '/elsewhere/objects\n');
    expect((await recover()).switchedBack).toEqual([]);
    expect(h.gitRefusals.map((e) => e.detail.kind)).toContain('alternates');
    const card = h.only(h.cards().filter((c) => c.title.startsWith('Your checkout')));
    expect(card.title).toBe(
      `Your checkout stays on ${batch.branch ?? ''}: 10db could not switch it back to main`,
    );
    expect(getBatchRow(h.store.db, batch.id)).toMatchObject({
      returnBranch: null,
      returnSha: null,
    });
    rmSync(alternates);
    expect((await recover()).switchedBack).toEqual([]);
    expect(where().branch).toBe(batch.branch);
  });

  it('does not hold startup for a chat in the terminal and switches back once it hands back, and settles no branch while the checkout is held by a terminal and 10db stops', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const start = where();
    const batch = await openBatch('CLOSED');
    endedWhileDown(batch, 'CLOSED');
    const terminal = inTheTerminal();
    // Startup returns with the checkout where it was and the place kept.
    expect((await recover()).switchedBack).toEqual([]);
    expect(where().branch).toBe(batch.branch);
    expect(getBatchRow(h.store.db, batch.id).returnSha).not.toBeNull();
    // The hand back says so, and the queued switch back runs.
    h.state.write((ctx) => {
      ctx.tx
        .update(schema.conversations)
        .set({ state: ConversationState.IdleCold })
        .where(eq(schema.conversations.id, terminal))
        .run();
      ctx.emit({
        type: EventType.ConversationState,
        entityType: 'conversation',
        entityId: terminal,
        data: { state: ConversationState.IdleCold },
      });
    });
    await h.jobs.idle();
    expect(where()).toEqual({ ...start, status: '' });

    // A batch with work on its branch, abandoned while another terminal holds the checkout.
    const held = await openBatch('SHIPPED');
    inTheTerminal();
    h.shipper.abandon(held.id);
    // The abandon's ship job waits for the terminal before it moves the checkout.
    await waitForAsync(
      () =>
        Promise.resolve(
          getBatchRow(h.store.db, held.id).notices.some((n) => n.key === 'folder-hold') ||
            undefined,
        ),
      30_000,
    );
    await h.jobs.stop();
    // Nothing ran git in the held folder: no card about the branch the checkout is still on.
    expect(h.cards().filter((card) => card.title.startsWith('Delete '))).toEqual([]);
    expect(where().branch).toBe(held.branch);
  });

  it('leaves the checkout while a lane runs in the project, and says so', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const batch = await openBatch('CLOSED');
    endedWhileDown(batch, 'CLOSED');
    const other = h.addTask('Running', { areas: ['ui'] });
    const ws = h.state.write((c) =>
      insertWorkstream(c, other.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    );
    h.settle(ws.id, 'RUNNING');
    await recover();
    expect(where().branch).toBe(batch.branch);
    const card = h.only(h.cards().filter((c) => c.title.startsWith('Your checkout')));
    expect(card.title).toBe(
      `Your checkout stays on ${batch.branch ?? ''}: work is running in ${h.project.name}`,
    );
  });
});

describe('what keeps the checkout where it is', () => {
  it('a workstream RUNNING or TAKEN_OVER in the project when the batch is abandoned', async () => {
    for (const state of ['RUNNING', 'TAKEN_OVER'] as const) {
      if (state !== 'RUNNING') h.close();
      h = createDeliveryHarness();
      const batch = await openBatch('ABANDONED');
      const other = h.addTask('Elsewhere', { areas: ['ui'] });
      const ws = h.state.write((c) =>
        insertWorkstream(c, other.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
      );
      h.settle(ws.id, state);
      await endLive(batch, 'ABANDONED');
      expect.soft(where().branch, state).toBe(batch.branch);
      expect
        .soft(
          h
            .cards()
            .filter((c) => c.title.startsWith('Your checkout'))
            .map((c) => c.title),
          state,
        )
        .toEqual([
          `Your checkout stays on ${batch.branch ?? ''}: work is running in ${h.project.name}`,
        ]);
    }
  });

  it('its branch checked out in another worktree, which git would refuse to check out twice', async () => {
    h = createDeliveryHarness();
    const elsewhere = tempDir('main-worktree');
    try {
      const batch = await openBatch('ABANDONED');
      const other = join(elsewhere.path, 'app-main');
      h.git$('worktree', 'add', '-q', other, 'main');
      await endLive(batch, 'ABANDONED');
      expect(where().branch).toBe(batch.branch);
      const card = h.only(h.cards().filter((c) => c.title.startsWith('Your checkout')));
      expect(card.title).toBe(
        `Your checkout stays on ${batch.branch ?? ''}: main is checked out in another worktree`,
      );
      expect(card.body).toContain(realpathSync(other));
      // No command to paste: git would refuse it.
      expect(card.body).not.toContain('git -C');
    } finally {
      h.git$('worktree', 'remove', '--force', join(elsewhere.path, 'app-main'));
      elsewhere.cleanup();
    }
  });

  it("an index a lane's commit left behind, which reads as uncommitted, never as a false switch", async () => {
    h = createDeliveryHarness();
    const batch = await openBatch('ABANDONED');
    writeFileSync(join(h.repo, 'README.md'), 'by a lane\n');
    const lock = join(h.repo, '.git', 'index.lock');
    writeFileSync(lock, '');
    try {
      await h.git.commit({
        repo: h.repo,
        paths: ['README.md'],
        message: 'lane',
        opId: 'op-stale-index',
        branch: batch.branch ?? '',
      });
    } finally {
      rmSync(lock);
    }
    await endLive(batch, 'ABANDONED');
    expect(where().branch).toBe(batch.branch);
    const card = h.only(h.cards().filter((c) => c.title.startsWith('Your checkout')));
    expect(card.title).toBe(
      `Your checkout stays on ${batch.branch ?? ''}: it has uncommitted changes`,
    );
    expect(card.body).toContain('- README.md');
  });

  it('ignored files where the switch would write', async () => {
    h = createDeliveryHarness();
    const batch = await openBatch('ABANDONED');
    h.git$('rm', '-q', 'README.md');
    writeFileSync(join(h.repo, '.gitignore'), 'README.md\n');
    h.git$('add', '.gitignore');
    h.git$('commit', '-q', '-m', 'ignore the readme');
    writeFileSync(join(h.repo, 'README.md'), 'mine\n');
    await endLive(batch, 'ABANDONED');
    expect(where().branch).toBe(batch.branch);
    const card = h.only(h.cards().filter((c) => c.title.startsWith('Your checkout')));
    expect(card.title).toBe(
      `Your checkout stays on ${batch.branch ?? ''}: ignored files are where main has files`,
    );
    expect(card.body).toContain('- README.md');
  });
});
