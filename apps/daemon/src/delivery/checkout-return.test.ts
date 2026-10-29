import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchDto } from '@10db/contracts';
import {
  getBatch,
  getBatchRow,
  insertWorkstream,
  listWorkstreams,
  transitionBatch,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
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
          ? { patch: { prUrl: 'https://github.com/acme/widgets/pull/1' } }
          : {}),
      });
    }
  });
}

const recover = () =>
  recoverBatches({
    state: h.state,
    git: h.git,
    inbox: h.inbox,
    processes: systemProcesses,
    shipper: h.shipper,
    logger: silentLogger,
  });

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

/** Asserts where the checkout ended and which card, if any, said why. */
function expectCheckout(
  batch: BatchDto,
  start: { readonly branch: string; readonly head: string },
  row: (typeof CHECKOUTS)[number],
): void {
  const now = where();
  switch (row.ends) {
    case 'start':
      expect(now).toEqual({ ...start, status: '' });
      break;
    case 'batch':
      expect(now.branch).toBe(batch.branch);
      break;
    case 'elsewhere':
      expect(now.branch).toBe('elsewhere');
  }
  const cards = h.cards().filter((card) => card.title.startsWith('Your checkout'));
  if (row.card) {
    const card = h.only(cards);
    expect(card.title).toMatch(row.card);
    expect(card.body).toContain('- notes.txt');
    expect(card.body).toContain(`git -C ${h.repo} switch main`);
  } else expect(cards).toEqual([]);
  // Done or declined, the place is forgotten, so a restart doesn't switch the checkout again.
  expect(getBatchRow(h.store.db, batch.id)).toMatchObject({ returnBranch: null, returnSha: null });
}

describe('the cut', () => {
  it('records where it found the checkout: a branch and its commit, or a detached commit', async () => {
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
  });

  it('records nothing for a worktree batch, which never touches the checkout', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const batch = await openBatch('CLOSED');
    expect(getBatchRow(h.store.db, batch.id)).toMatchObject({
      returnBranch: null,
      returnSha: null,
    });
  });
});

describe('when a batch ends', () => {
  const live = ENDS.flatMap((end) =>
    CHECKOUTS.filter(
      // Shipping checks the branch and a clean checkout first, so only Abandon ends a batch whose
      // checkout is dirty or moved while the daemon runs.
      (row) => end === 'ABANDONED' || row.ends === 'start',
    ).map((row) => ({ ...row, end, title: `${end}, ${row.name}` })),
  );

  it.each(live)('$title', async (row) => {
    h = createDeliveryHarness();
    row.before?.();
    const start = where();
    const batch = await openBatch(row.end);
    expect(where().branch).toBe(batch.branch);
    row.arrange?.(batch);
    const ended = await endLive(batch, row.end);
    expect(ended.state).toBe(row.end);
    expectCheckout(batch, start, row);
  });

  it('keeps the shipped work on its branch and on origin after switching back', async () => {
    h = createDeliveryHarness();
    const batch = await openBatch('SHIPPED');
    const tip = h.git$('rev-parse', 'HEAD');
    await endLive(batch, 'SHIPPED');
    expect(where().branch).toBe('main');
    expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(tip);
    expect(h.origin$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(tip);
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

  it.each(matrix)('$title: startup recovery acts as the end would have', async (row) => {
    h = createDeliveryHarness({}, { trigger: false });
    row.before?.();
    const start = where();
    const batch = await openBatch(row.end);
    row.arrange?.(batch);
    endedWhileDown(batch, row.end);
    await recover();
    expectCheckout(batch, start, row);
    // A second start finds nothing left to do.
    await recover();
    expectCheckout(batch, start, row);
  });

  it('keeps the place while git refuses the checkout, and switches back once it is trusted again', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const start = where();
    const batch = await openBatch('CLOSED');
    endedWhileDown(batch, 'CLOSED');
    const alternates = join(h.repo, '.git', 'objects', 'info', 'alternates');
    writeFileSync(alternates, '/elsewhere/objects\n');
    expect((await recover()).switchedBack).toEqual([]);
    expect(h.gitRefusals.map((e) => e.detail.kind)).toContain('alternates');
    expect(h.cards().filter((c) => c.title.startsWith('Your checkout'))).toEqual([]);
    expect(getBatchRow(h.store.db, batch.id).returnBranch).toBe('main');
    rmSync(alternates);
    expect((await recover()).switchedBack).toEqual([batch.id]);
    expect(where()).toEqual({ ...start, status: '' });
  });

  it('leaves the checkout while a lane runs in the project, and says so', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const batch = await openBatch('CLOSED');
    endedWhileDown(batch, 'CLOSED');
    const other = h.addTask('Running', { areas: ['ui'] });
    const ws = h.state.write((c) => insertWorkstream(c, other.id));
    h.settle(ws.id, 'RUNNING');
    await recover();
    expect(where().branch).toBe(batch.branch);
    const card = h.only(h.cards().filter((c) => c.title.startsWith('Your checkout')));
    expect(card.title).toBe(
      `Your checkout stays on ${batch.branch ?? ''}: work is running in ${h.project.name}`,
    );
  });
});
