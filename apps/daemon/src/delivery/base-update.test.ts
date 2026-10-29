import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { BatchDto, WorkstreamDto } from '@10db/contracts';
import { getBatch, getWorkstreamRow, listWorkstreams, patchWorkstream } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv } from '../../test/fixtures';
import { createBaseUpdates } from './index';

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

const signal = new AbortController().signal;

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
}

function pathOf(batch: BatchDto): string {
  if (batch.worktreePath === null) throw new Error(`batch ${batch.title} has no worktree path`);
  return batch.worktreePath;
}

/** Starts one task and waits for its batch to open; its workstream starts at the batch's base. */
async function opened(): Promise<{ batch: BatchDto; ws: WorkstreamDto }> {
  const started = h.starter.startTask(h.addTask('Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  expect(batch.state).toBe('OPEN');
  const ws = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
  // Where the runner's first session records it.
  h.state.write((c) => {
    patchWorkstream(c, ws.id, null, { baseHead: batch.baseSha ?? '' });
  });
  return { batch, ws };
}

/** Writes and commits a file on the batch branch where its work is, as the commit tool does. */
async function commitOnBatch(batch: BatchDto, path: string, content = `${path}\n`) {
  const checkout = batch.worktreePath ?? h.repo;
  const file = join(checkout, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  const { sha } = await h.git.commit({
    repo: checkout,
    paths: [path],
    message: `Add ${path}`,
    opId: `op-${path.replaceAll('/', '-')}`,
    branch: batch.branch ?? '',
  });
  return sha;
}

/** The delivery log's lines with message `msg`. */
const logged = (msg: string) => h.logs.lines().filter((line) => line['msg'] === msg);

/** What the gate would see of a checkout: its branch, HEAD and changes. */
function state(checkout: string) {
  return {
    branch: gitIn(checkout, 'branch', '--show-current'),
    head: gitIn(checkout, 'rev-parse', 'HEAD'),
    status: gitIn(checkout, 'status', '--porcelain', '--untracked-files=all'),
  };
}

describe('bringing a worktree batch up to date with its base before a gate', () => {
  it("merges the base as origin has it now into the batch's branch, and moves the batch's base and its task's starting point", async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const { batch, ws } = await opened();
    const own = await commitOnBatch(batch, 'src/api/alpha.txt');
    const teammate = h.teammatePush('main', 'src/ui/teammate.txt');
    const update = await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
    const path = pathOf(batch);
    const head = gitIn(path, 'rev-parse', 'HEAD');
    expect(update).toEqual({ kind: 'merged', base: teammate, head, note: null });
    expect(gitIn(path, 'log', '-1', '--format=%P %s')).toBe(
      `${own} ${teammate} Merge origin/main into ${batch.branch ?? ''}`,
    );
    expect(readFileSync(join(path, 'src/ui/teammate.txt'), 'utf8')).toBe('src/ui/teammate.txt\n');
    expect(state(path).status).toBe('');
    expect(getBatch(h.store.db, batch.id).baseSha).toBe(teammate);
    expect(getWorkstreamRow(h.store.db, ws.id).baseHead).toBe(teammate);
    expect(logged('base merged into the batch branch')).toHaveLength(1);
    expect(h.cards()).toEqual([]);
  });

  it('changes nothing when origin has nothing newer', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    const before = state(pathOf(batch));
    expect(await createBaseUpdates(h.ctx).beforeGate(batch.id, signal)).toEqual({
      kind: 'up_to_date',
    });
    expect(state(pathOf(batch))).toEqual(before);
    expect(getBatch(h.store.db, batch.id).baseSha).toBe(batch.baseSha);
  });

  it('runs the install again when the base changed the lockfile', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    h.commit('.gitignore', 'node_modules/\n');
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    h.git$('push', '-q', 'origin', 'main');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    const { batch } = await opened();
    const path = realpathSync(pathOf(batch));
    expect(h.pnpm.calls()).toHaveLength(1);
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/teammate.txt');
    await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
    // A merge that leaves the lockfile alone needs no install.
    expect(h.pnpm.calls()).toHaveLength(1);
    h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\npackages: {}\n');
    const update = await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
    expect(update.kind).toBe('merged');
    expect(h.pnpm.calls()).toHaveLength(2);
    expect(h.pnpm.calls()[1]).toMatch(new RegExp(`^${path} \\| install --frozen-lockfile`));
  });

  it("says in the gate's note when the install after the merge failed", async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    h.commit('.gitignore', 'node_modules/\n');
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    h.git$('push', '-q', 'origin', 'main');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\npackages: {}\n');
    h.pnpm.failWith(1, 'ERR_PNPM_FETCH_403');
    const update = await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
    expect(update).toMatchObject({ kind: 'merged' });
    expect(update.kind === 'merged' && update.note).toMatch(
      /^10db merged origin\/main into this branch, but the install its lockfile needs failed \(exit 1; log: .+\.log\), so the packages may not match it\.$/,
    );
  });

  describe('gates the branch as it is, and says why', () => {
    it.each([
      {
        name: 'a conflict with the base',
        setup: async (batch: BatchDto) => {
          await commitOnBatch(batch, 'README.md', '# ours\n');
          h.teammatePush('main', 'README.md', '# theirs\n');
        },
        note: /^origin\/main conflicts with this branch in README\.md, so this gate ran without its newer commits/,
      },
      {
        name: 'an uncommitted change where the base changed a file',
        setup: async (batch: BatchDto) => {
          await commitOnBatch(batch, 'src/api/alpha.txt');
          h.teammatePush('main', 'README.md', '# theirs\n');
          writeFileSync(join(pathOf(batch), 'README.md'), '# a lane is still writing\n');
        },
        note: /^Uncommitted changes in README\.md are in the way of origin\/main's newer commits, so this gate ran without them/,
      },
      {
        name: 'a fetch that fails',
        setup: async (batch: BatchDto) => {
          await commitOnBatch(batch, 'src/api/alpha.txt');
          renameSync(h.origin, `${h.origin}-unreachable`);
        },
        note: /^10db couldn't fetch main from origin \(.+\), so this gate ran on the branch without any newer commits on main/,
      },
    ])('$name', async ({ setup, note }) => {
      h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
      const { batch } = await opened();
      await setup(batch);
      const before = state(pathOf(batch));
      try {
        const update = await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
        expect(update.kind).toBe('not_merged');
        expect(update.kind === 'not_merged' && update.note).toMatch(note);
      } finally {
        if (existsSync(`${h.origin}-unreachable`)) renameSync(`${h.origin}-unreachable`, h.origin);
      }
      expect(state(pathOf(batch))).toEqual(before);
      expect(getBatch(h.store.db, batch.id).baseSha).toBe(batch.baseSha);
      expect(logged('base not merged before the gate')).toHaveLength(1);
    });
  });

  it('raises one card for a conflict, however many gates meet it', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'README.md', '# ours\n');
    h.teammatePush('main', 'README.md', '# theirs\n');
    const updates = createBaseUpdates(h.ctx);
    await updates.beforeGate(batch.id, signal);
    await updates.beforeGate(batch.id, signal);
    const card = h.only(h.cards());
    expect(card.title).toBe('Batch "Alpha" conflicts with main');
    expect(card.body).toContain('- README.md');
    expect(card.body).toContain(`git -C ${pathOf(batch)} merge origin/main`);
    expect(card.detail).toEqual({ batchId: batch.id, paths: ['README.md'] });
  });

  it('does nothing once shutdown has aborted it', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/teammate.txt');
    const before = state(pathOf(batch));
    const stop = new AbortController();
    stop.abort();
    expect(await createBaseUpdates(h.ctx).beforeGate(batch.id, stop.signal)).toEqual({
      kind: 'aborted',
    });
    expect(state(pathOf(batch))).toEqual(before);
  });
});

describe("a batch in the builder's own checkout (shared mode)", () => {
  it('never merges into the checkout, and says how far behind the base the branch is', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/one.txt');
    h.teammatePush('main', 'src/ui/two.txt');
    const before = state(h.repo);
    const update = await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
    expect(update).toEqual({
      kind: 'not_merged',
      note: `origin/main has 2 commits this branch doesn't. 10db merges the base only into the worktrees it makes, never into the builder's own checkout, so this gate ran without them: a failure they fix shows here until origin/main is merged into ${batch.branch ?? ''}.`,
    });
    expect(state(h.repo)).toEqual(before);
    expect(existsSync(join(h.repo, 'src/ui/one.txt'))).toBe(false);
    expect(getBatch(h.store.db, batch.id).baseSha).toBe(batch.baseSha);
  });

  it('says nothing when the branch holds the base', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    expect(await createBaseUpdates(h.ctx).beforeGate(batch.id, signal)).toEqual({
      kind: 'up_to_date',
    });
  });
});
