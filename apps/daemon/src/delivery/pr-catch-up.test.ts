import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BatchDto, WorkstreamDto } from '@10db/contracts';
import { getBatch, listWorkstreams, patchProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { GhError, PrMergeable } from '../github';

// Each case builds a real repository, a worktree, a push and a teammate's push.
vi.setConfig({ testTimeout: 120_000 });

let h: DeliveryHarness;
beforeEach(() => {
  // The tests settle work and ask the shipper themselves.
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
  h.commit('src/index.ts', "import a from './a';\nexport {};\n");
  h.git$('push', '-q', 'origin', 'main');
});
afterEach(() => {
  h.close();
});

const BOTH = {
  mine: "import a from './a';\nimport b from './b';\nexport {};\n",
  theirs: "import a from './a';\nimport c from './c';\nexport {};\n",
};

/** The SHA of `branch` on origin. */
const onOrigin = (branch: string | null): string =>
  h.origin$('rev-parse', '--verify', '-q', `refs/heads/${branch ?? ''}`);

/** Commits a file in the batch's worktree, as the commit tool does for an agent. */
async function commitIn(batch: BatchDto, path: string, content = `${path}\n`): Promise<void> {
  const checkout = batch.worktreePath ?? '';
  const file = join(checkout, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  await h.git.commit({
    repo: checkout,
    paths: [path],
    message: `Add ${path}`,
    opId: `op-${path.replaceAll('/', '-')}`,
    branch: batch.branch ?? '',
  });
}

/** Ships one task that wrote `path`; resolves with the SHIPPED batch. */
async function shipped(path = 'src/index.ts', content = BOTH.mine): Promise<BatchDto> {
  const started = h.starter.startTask(h.addTask('Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  await commitIn(batch, path, content);
  const ws: WorkstreamDto = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
  h.settle(ws.id, 'DONE');
  h.shipper.checkBatch(batch.id);
  await h.jobs.idle();
  const now = getBatch(h.store.db, batch.id);
  expect(now.state).toBe('SHIPPED');
  return now;
}

/** GitHub now says the pull request conflicts with main, at the branch's tip on origin. */
function conflicts(batch: BatchDto): string {
  const url = batch.prUrl ?? '';
  h.gh.setHead(url, onOrigin(batch.branch));
  h.gh.setMergeBlocked(url, 'conflicts');
  h.gh.setMergeable(url, PrMergeable.Conflicting);
  return url;
}

async function catchUp(batch: BatchDto): Promise<BatchDto> {
  h.shipper.catchUp(batch.id);
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

describe('a shipped pull request that conflicts with its base', () => {
  it('has the base merged into it, settled conflicts named, pushed, and no card', async () => {
    const batch = await shipped();
    const teammate = h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = onOrigin(batch.branch);
    conflicts(batch);

    const now = await catchUp(batch);

    const tip = onOrigin(batch.branch);
    expect(tip).not.toBe(before);
    expect(h.origin$('log', '-1', '--format=%P', tip)).toBe(`${before} ${teammate}`);
    expect(h.origin$('show', `${tip}:src/index.ts`)).toBe(
      "import a from './a';\nimport b from './b';\nimport c from './c';\nexport {};",
    );
    expect(h.cards()).toEqual([]);
    const notice = h.only(now.notices);
    expect(notice).toMatchObject({ key: 'pull-request-update', tone: 'info' });
    expect(notice.line).toBe('10db merged main into the pull request, resolving src/index.ts');
    expect(notice.body).toContain('src/index.ts');
    // The worktree it merged in is gone again.
    expect(now.worktreePath).toBeNull();
    expect(h.git$('worktree', 'list', '--porcelain')).not.toContain(batch.branch ?? 'x');
  });

  it('runs the gate on the merged branch before it pushes', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    const before = onOrigin(batch.branch);
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));

    const now = await catchUp(batch);

    expect(onOrigin(batch.branch)).toBe(before);
    const card = h.only(h.cards());
    expect(card.title).toContain('gate failed');
    expect(card.body).toContain('main');
    expect(now.notices.map((n) => n.key)).not.toContain('pull-request-update');
    expect(now.worktreePath).toBeNull();
  });

  it('merges it once GitHub says it is clean, when it had refused the merge', async () => {
    h.gh.noRequiredChecks = true;
    h.gh.failNext.set(
      'prMerge',
      new GhError(
        'failed',
        'gh pr merge failed (exit 1): the merge commit cannot be cleanly created',
      ),
    );
    const batch = await shipped();
    expect(batch.notices.map((n) => n.key)).toEqual(['pull-request-merge']);
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const url = conflicts(batch);

    await catchUp(batch);
    // GitHub works out the new head and calls it clean.
    h.gh.setHead(url, onOrigin(batch.branch));
    h.gh.setMergeBlocked(url, null);
    h.gh.setMergeable(url, PrMergeable.Mergeable);
    h.shipper.retryMerge(batch.id);
    await h.jobs.idle();

    expect(h.gh.merged).toEqual([url]);
    expect(getBatch(h.store.db, batch.id).notices.map((n) => n.key)).toEqual([
      'pull-request-update',
    ]);
    expect(h.cards()).toEqual([]);
  });

  it('raises one card naming the files when 10db cannot settle the conflict, and pushes nothing', async () => {
    h.gh.noRequiredChecks = true;
    h.gh.failNext.set('prMerge', new GhError('failed', 'gh pr merge failed (exit 1): conflict'));
    const batch = await shipped('README.md', '# ours\n');
    h.teammatePush('main', 'README.md', '# theirs\n');
    const before = onOrigin(batch.branch);
    conflicts(batch);

    const now = await catchUp(batch);

    expect(onOrigin(batch.branch)).toBe(before);
    const card = h.only(h.cards());
    expect(card.title).toContain('conflicts with main');
    expect(card.body).toContain('README.md');
    expect(card.body).toContain('Update branch');
    // The card is the one thing said: neither of the two notices stands.
    expect(now.notices).toEqual([]);
    expect(now.worktreePath).toBeNull();

    // Asked again for the same pull request head, it does not start over or raise another.
    await catchUp(now);
    expect(h.cards()).toHaveLength(1);
    expect(
      h.logs.lines().filter((l) => l['msg'] === 'base not merged before the gate'),
    ).toHaveLength(1);
  });

  it('does nothing once GitHub no longer says it conflicts', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = onOrigin(batch.branch);
    // GitHub says clean (the default).
    const now = await catchUp(batch);
    expect(onOrigin(batch.branch)).toBe(before);
    expect(now.notices).toEqual([]);
  });

  it('is left to the builder when the batch did not ask to be merged by itself', async () => {
    h.close();
    h = createDeliveryHarness({ workspaceMode: 'worktree', landing: 'hold' }, { trigger: false });
    h.commit('src/index.ts', "import a from './a';\nexport {};\n");
    h.git$('push', '-q', 'origin', 'main');
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = onOrigin(batch.branch);
    conflicts(batch);
    await catchUp(batch);
    expect(onOrigin(batch.branch)).toBe(before);
    expect(h.cards()).toEqual([]);
  });
});

describe('a merge GitHub refused for a reason that has gone', () => {
  it('is retried, once, and merged', async () => {
    h.gh.noRequiredChecks = true;
    h.gh.failNext.set(
      'prMerge',
      new GhError('failed', 'gh pr merge failed (exit 1): not mergeable'),
    );
    const batch = await shipped();
    expect(h.gh.merged).toEqual([]);
    expect(batch.notices.map((n) => n.key)).toEqual(['pull-request-merge']);

    h.shipper.retryMerge(batch.id);
    await h.jobs.idle();

    expect(h.gh.merged).toEqual([batch.prUrl]);
    expect(getBatch(h.store.db, batch.id).notices).toEqual([]);
  });

  it('is not retried again at once when GitHub refuses it again', async () => {
    h.gh.noRequiredChecks = true;
    const refusal = () => new GhError('failed', 'gh pr merge failed (exit 1): not mergeable');
    h.gh.failNext.set('prMerge', refusal());
    const batch = await shipped();
    h.gh.failNext.set('prMerge', refusal());
    h.shipper.retryMerge(batch.id);
    await h.jobs.idle();
    h.shipper.retryMerge(batch.id);
    await h.jobs.idle();
    expect(h.gh.calls.filter((c) => c.method === 'prMerge')).toHaveLength(2);
    expect(h.gh.merged).toEqual([]);
  });

  it('asks nothing when no merge was refused', async () => {
    const batch = await shipped();
    const calls = h.gh.calls.length;
    h.shipper.retryMerge(batch.id);
    await h.jobs.idle();
    expect(h.gh.calls).toHaveLength(calls);
  });
});
