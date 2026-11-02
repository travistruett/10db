import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BatchDto, WorkstreamDto } from '@10db/contracts';
import { getBatch, listWorkstreams, patchBatch, patchProject } from '@10db/db';
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
async function shipped(
  path = 'src/index.ts',
  content = BOTH.mine,
  opts: { readonly keepWorktree?: boolean } = {},
): Promise<BatchDto> {
  const started = h.starter.startTask(h.addTask('Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  await commitIn(batch, path, content);
  if (opts.keepWorktree) {
    // A hand-made, git-ignored .env 10db didn't seed: the worktree stays after the ship.
    writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.env\n');
    writeFileSync(join(batch.worktreePath ?? '', '.env'), 'SECRET=1\n');
  }
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
    // 10db's merge, which it did not push, is not left on the local branch.
    expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(before);
  });

  it('lists the files 10db settled in the merge on the card when the pre-check fails on the result', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    const before = onOrigin(batch.branch);
    h.state.write((c) =>
      patchProject(c, h.project.id, { gateCommand: 'true', precheckCommand: 'false' }),
    );

    await catchUp(batch);

    expect(onOrigin(batch.branch)).toBe(before);
    const card = h.only(h.cards());
    expect(card.title).toContain('pre-check failed');
    expect(card.body).toContain('10db settled these files itself in the merge');
    expect(card.body).toContain('src/index.ts');
  });

  it('puts the local branch back at the pull request head when the check fails in the worktree it kept', async () => {
    const batch = await shipped('src/index.ts', BOTH.mine, { keepWorktree: true });
    const kept = batch.worktreePath ?? '';
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    const before = onOrigin(batch.branch);
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));

    await catchUp(batch);

    expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(before);
    expect(h.git$('-C', kept, 'rev-parse', 'HEAD')).toBe(before);
    expect(h.git$('-C', kept, 'status', '--porcelain')).toBe('');
    expect(h.git$('-C', kept, 'show', 'HEAD:src/index.ts')).toBe(BOTH.mine.trimEnd());
  });

  it('catches up again after a failed check and the builder updating the branch on GitHub', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const url = conflicts(batch);
    const branch = batch.branch ?? '';
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
    await catchUp(batch);
    expect(h.cards()).toHaveLength(1);

    // The builder presses Update branch: GitHub's head gains a commit the local branch lacks.
    const byHand = h.origin$(
      '-c',
      'user.name=Builder',
      '-c',
      'user.email=builder@example.com',
      'commit-tree',
      `refs/heads/${branch}^{tree}`,
      '-p',
      onOrigin(branch),
      '-m',
      'Update branch',
    );
    h.origin$('update-ref', `refs/heads/${branch}`, byHand);
    // The base moves again, and the builder's fix of the check is in.
    h.teammatePush('main', 'src/other.ts', 'export {};\n');
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'true' }));
    h.gh.setHead(url, byHand);

    await catchUp(getBatch(h.store.db, batch.id));

    expect(h.cards().filter((c) => c.body.includes("can't tell which is current"))).toEqual([]);
    expect(h.origin$('log', '-1', '--format=%P', onOrigin(branch)).split(' ')[0]).toBe(byHand);
  });

  it('starts from the pull request head when the local branch holds an earlier unpushed merge of 10db', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const url = conflicts(batch);
    const branch = batch.branch ?? '';
    const head = onOrigin(branch);
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
    // An earlier catch-up's merge of main fails its check and can't be put back: it stays, unpushed.
    vi.spyOn(h.git, 'rewindBranch').mockRejectedValueOnce(new Error('index.lock exists'));
    await catchUp(batch);
    const stale = h.git$('rev-parse', `refs/heads/${branch}`);
    expect(h.git$('log', '-1', '--format=%P', stale).split(' ')).toHaveLength(2);
    expect(onOrigin(branch)).toBe(head);

    // Its retry time passes, and the next catch-up starts from the head again.
    h.shipClock.advance(31 * 60_000);
    await catchUp(getBatch(h.store.db, batch.id));

    expect(h.git$('rev-parse', `refs/heads/${branch}`)).toBe(head);
    expect(h.cards().filter((c) => c.body.includes('lacks'))).toEqual([]);
    expect(onOrigin(branch)).toBe(head);

    // The builder presses Update branch, the base moves again and the check is fixed.
    const byHand = h.origin$(
      '-c',
      'user.name=Builder',
      '-c',
      'user.email=builder@example.com',
      'commit-tree',
      `refs/heads/${branch}^{tree}`,
      '-p',
      head,
      '-m',
      'Update branch',
    );
    h.origin$('update-ref', `refs/heads/${branch}`, byHand);
    h.teammatePush('main', 'src/other.ts', 'export {};\n');
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'true' }));
    h.gh.setHead(url, byHand);

    await catchUp(getBatch(h.store.db, batch.id));

    expect(h.cards().filter((c) => c.body.includes("can't tell which is current"))).toEqual([]);
    expect(h.origin$('log', '-1', '--format=%P', onOrigin(branch)).split(' ')[0]).toBe(byHand);
  });

  it("keeps a builder's local commit one ahead of the pull request head and raises a card naming it", async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    const branch = batch.branch ?? '';
    const head = onOrigin(branch);
    // A hand commit on the local branch, never pushed: not a merge of 10db's.
    const byHand = h.git$(
      '-c',
      'user.name=Builder',
      '-c',
      'user.email=builder@example.com',
      'commit-tree',
      `${head}^{tree}`,
      '-p',
      head,
      '-m',
      'Fix by hand',
    );
    h.git$('update-ref', `refs/heads/${branch}`, byHand, head);

    await catchUp(batch);

    expect(h.git$('rev-parse', `refs/heads/${branch}`)).toBe(byHand);
    expect(onOrigin(branch)).toBe(head);
    const card = h.only(h.cards());
    expect(card.body).toContain(byHand.slice(0, 7));
  });

  it("keeps the builder's own merge of main ahead of the pull request head and raises a card naming it", async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    const branch = batch.branch ?? '';
    const head = onOrigin(branch);
    h.git$('fetch', '-q', 'origin');
    // The builder runs `git merge origin/main` and settles the conflict by hand, not yet pushed.
    const byHand = h.git$(
      '-c',
      'user.name=Builder',
      '-c',
      'user.email=builder@example.com',
      'commit-tree',
      `${head}^{tree}`,
      '-p',
      head,
      '-p',
      'origin/main',
      '-m',
      "Merge branch 'main'",
    );
    h.git$('update-ref', `refs/heads/${branch}`, byHand, head);

    await catchUp(batch);

    expect(h.git$('rev-parse', `refs/heads/${branch}`)).toBe(byHand);
    expect(onOrigin(branch)).toBe(head);
    const card = h.only(h.cards());
    expect(card.body).toContain(byHand.slice(0, 7));
  });

  it('keeps an unpushed merge of 10db after a restart and raises a card naming it', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    const branch = batch.branch ?? '';
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
    vi.spyOn(h.git, 'rewindBranch').mockRejectedValueOnce(new Error('index.lock exists'));
    await catchUp(batch);
    const stale = h.git$('rev-parse', `refs/heads/${branch}`);
    expect(stale).not.toBe(onOrigin(branch));

    // The daemon restarts: what it knew of its own merge is gone.
    h.restartShipper();
    await catchUp(getBatch(h.store.db, batch.id));

    expect(h.git$('rev-parse', `refs/heads/${branch}`)).toBe(stale);
    const card = h.only(h.cards());
    expect(card.body).toContain(stale.slice(0, 7));
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

  it('merges it after a restart once the builder settles a conflict 10db could not, when GitHub had refused the merge', async () => {
    h.gh.noRequiredChecks = true;
    h.gh.failNext.set(
      'prMerge',
      new GhError(
        'failed',
        'gh pr merge failed (exit 1): the merge commit cannot be cleanly created',
      ),
    );
    const batch = await shipped('README.md', '# ours\n');
    h.teammatePush('main', 'README.md', '# theirs\n');
    const url = conflicts(batch);
    const stopped = await catchUp(batch);
    expect(h.cards()).toHaveLength(1);
    expect(stopped.notices).toEqual([]);

    // The daemon restarts; the builder resolves the conflict on GitHub, as the card says.
    h.restartShipper();
    h.gh.setMergeBlocked(url, null);
    h.gh.setMergeable(url, PrMergeable.Mergeable);
    // The watch withdraws the open card in the round that reads the pull request clean, and says so.
    h.shipper.retryMerge(batch.id, { catchUpCardWasOpen: true });
    await h.jobs.idle();

    expect(h.gh.merged).toEqual([url]);
  });

  it('shows the refused notice when auto-merge errors on a retry and was never armed', async () => {
    // GitHub refused the first arm, so the pull request was never set to merge.
    h.gh.failNext.set(
      'prAutoMerge',
      new GhError('failed', 'gh pr merge failed (exit 1): auto-merge is not allowed'),
    );
    const batch = await shipped('README.md', '# ours\n');
    expect(batch.notices.map((n) => n.key)).toEqual(['pull-request-merge']);
    h.teammatePush('main', 'README.md', '# theirs\n');
    const url = conflicts(batch);
    const stopped = await catchUp(batch);
    expect(stopped.notices).toEqual([]);

    // The builder resolves the conflict; the watch withdraws the card and asks for the merge again.
    h.gh.setMergeBlocked(url, null);
    h.gh.setMergeable(url, PrMergeable.Mergeable);
    h.gh.failNext.set(
      'prAutoMerge',
      new GhError('failed', 'gh pr merge failed (exit 1): HTTP 403: Resource not accessible'),
    );
    h.shipper.retryMerge(batch.id, { catchUpCardWasOpen: true });
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id).notices.map((n) => n.key)).toEqual([
      'pull-request-merge',
    ]);
  });

  it('treats an auto-merge error on a retry as armed, with no notice, when it was armed before', async () => {
    // The first arm succeeds, so the pull request is known to be set to merge.
    const batch = await shipped('README.md', '# ours\n');
    expect(batch.notices.map((n) => n.key)).not.toContain('pull-request-merge');
    h.teammatePush('main', 'README.md', '# theirs\n');
    const url = conflicts(batch);
    const stopped = await catchUp(batch);
    expect(stopped.notices).toEqual([]);

    // The builder resolves the conflict; the watch withdraws the card and asks for the merge again,
    // and gh's answer to arming a pull request that is armed already is an error.
    h.gh.setMergeBlocked(url, null);
    h.gh.setMergeable(url, PrMergeable.Mergeable);
    h.gh.failNext.set(
      'prAutoMerge',
      new GhError('failed', 'gh pr merge failed (exit 1): HTTP 403: Resource not accessible'),
    );
    h.shipper.retryMerge(batch.id, { catchUpCardWasOpen: true });
    await h.jobs.idle();

    expect(h.gh.failNext.has('prAutoMerge')).toBe(false);
    expect(getBatch(h.store.db, batch.id).notices.map((n) => n.key)).not.toContain(
      'pull-request-merge',
    );
  });

  it('merges the base in the worktree 10db kept after the ship, and keeps it', async () => {
    const batch = await shipped('src/index.ts', BOTH.mine, { keepWorktree: true });
    const kept = batch.worktreePath ?? '';
    expect(kept).not.toBe('');
    const teammate = h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = onOrigin(batch.branch);
    conflicts(batch);

    const now = await catchUp(batch);

    const tip = onOrigin(batch.branch);
    expect(h.origin$('log', '-1', '--format=%P', tip)).toBe(`${before} ${teammate}`);
    expect(now.notices.map((n) => n.key)).toEqual(['pull-request-update']);
    expect(h.cards().filter((c) => c.title.includes('conflicts with main'))).toEqual([]);
    // The kept worktree is still there and still named, with the builder's file in it.
    expect(now.worktreePath).toBe(kept);
    expect(existsSync(join(kept, '.env'))).toBe(true);
    expect(h.git$('-C', kept, 'rev-parse', 'HEAD')).toBe(tip);
  });

  it('raises one card when a checkout 10db did not make holds the branch', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = onOrigin(batch.branch);
    conflicts(batch);
    const byHand = mkdtempSync(join(tmpdir(), 'by-hand-'));
    try {
      h.git$('worktree', 'add', '-q', join(byHand, 'wt'), batch.branch ?? '');

      const now = await catchUp(batch);

      expect(onOrigin(batch.branch)).toBe(before);
      const card = h.only(h.cards());
      expect(card.title).toContain('conflicts with main');
      expect(card.body).toContain(`${batch.branch ?? ''} is checked out at`);
      expect(now.notices).toEqual([]);
      // Not asked again for the same head.
      await catchUp(now);
      expect(h.cards()).toHaveLength(1);
    } finally {
      rmSync(byHand, { recursive: true, force: true });
    }
  });

  /** A second batch whose worktree, made by hand at `where`, holds the shipped batch's branch. */
  function holdBy(
    batch: BatchDto,
    where: string,
    patch: { readonly state: 'OPEN' | 'FAILED'; readonly ciFixOf: BatchDto['id'] | null },
  ): void {
    h.git$('worktree', 'add', '-q', where, batch.branch ?? '');
    const other = h.starter.startTask(h.addTask('Beta').id);
    h.state.write((w) => patchBatch(w, other.id, { ...patch, worktreePath: where }));
  }

  it('raises its card when the batch that holds the branch in a kept worktree has failed', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = onOrigin(batch.branch);
    conflicts(batch);
    const byHand = mkdtempSync(join(tmpdir(), 'by-hand-'));
    try {
      holdBy(batch, join(byHand, 'wt'), { state: 'FAILED', ciFixOf: batch.id });

      const now = await catchUp(batch);

      expect(onOrigin(batch.branch)).toBe(before);
      const card = h.only(h.cards().filter((c) => c.title.includes('conflicts with main')));
      expect(card.body).toContain(`${batch.branch ?? ''} is checked out at`);
      expect(now.notices).toEqual([]);
    } finally {
      rmSync(byHand, { recursive: true, force: true });
    }
  });

  it('says on its tasks that it conflicts while a running CI fix holds the branch, and asks again', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = onOrigin(batch.branch);
    conflicts(batch);
    const byHand = mkdtempSync(join(tmpdir(), 'by-hand-'));
    try {
      holdBy(batch, join(byHand, 'wt'), { state: 'OPEN', ciFixOf: batch.id });

      const now = await catchUp(batch);

      expect(onOrigin(batch.branch)).toBe(before);
      expect(now.notices.map((n) => n.key)).toEqual(['base-conflict']);
      expect(now.notices[0]?.line).toContain('conflicts with main');
      expect(h.cards().filter((c) => c.title.includes('conflicts with main'))).toEqual([]);
    } finally {
      rmSync(byHand, { recursive: true, force: true });
    }
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

describe('a shipped pull request whose head never got its required checks', () => {
  /** GitHub holds the pull request, which merges cleanly, for a required check that has no run. */
  function waitsForChecks(batch: BatchDto): string {
    const url = batch.prUrl ?? '';
    h.gh.setHead(url, onOrigin(batch.branch));
    h.gh.setBlockedOnChecks(url, true);
    return url;
  }

  async function restartCi(batch: BatchDto): Promise<BatchDto> {
    h.shipper.restartCi(batch.id);
    await h.jobs.idle();
    return getBatch(h.store.db, batch.id);
  }

  it('has the base merged into it and pushed, so a new head gets its workflows', async () => {
    const batch = await shipped();
    const teammate = h.teammatePush('main', 'src/other.ts', 'export {};\n');
    const before = onOrigin(batch.branch);
    waitsForChecks(batch);

    const now = await restartCi(batch);

    const tip = onOrigin(batch.branch);
    expect(tip).not.toBe(before);
    expect(h.origin$('log', '-1', '--format=%P', tip)).toBe(`${before} ${teammate}`);
    expect(h.cards()).toEqual([]);
    const notice = h.only(now.notices);
    expect(notice).toMatchObject({ key: 'pull-request-update', tone: 'info' });
    expect(notice.line).toBe('10db merged main into the pull request to start its checks');
    expect(now.worktreePath).toBeNull();
  });

  it('pushes nothing when the branch already holds the base, and raises no card', async () => {
    const batch = await shipped();
    const before = onOrigin(batch.branch);
    waitsForChecks(batch);

    const now = await restartCi(batch);

    expect(onOrigin(batch.branch)).toBe(before);
    expect(h.cards()).toEqual([]);
    expect(now.notices).toEqual([]);
  });

  it.each([
    ['running', [{ name: 'build', conclusion: null }]],
    ['passed', [{ name: 'build', conclusion: 'SUCCESS' }]],
    ['failed', [{ name: 'build', conclusion: 'FAILURE' }]],
  ])('never pushes to a pull request whose checks are %s', async (_name, runs) => {
    const batch = await shipped();
    h.teammatePush('main', 'src/other.ts', 'export {};\n');
    const before = onOrigin(batch.branch);
    const url = waitsForChecks(batch);
    h.gh.setChecks(
      url,
      runs.map((r) => ({
        __typename: 'CheckRun' as const,
        name: r.name,
        status: r.conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
        conclusion: r.conclusion,
        detailsUrl: null,
      })),
    );

    const now = await restartCi(batch);

    expect(onOrigin(batch.branch)).toBe(before);
    expect(now.notices).toEqual([]);
  });

  it('pushes nothing when GitHub is not blocked on checks, such as a base with no CI', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/other.ts', 'export {};\n');
    const before = onOrigin(batch.branch);
    const url = waitsForChecks(batch);
    h.gh.setBlockedOnChecks(url, false);

    await restartCi(batch);

    expect(onOrigin(batch.branch)).toBe(before);
  });

  it('runs the gate on the merged branch, and on a failure pushes nothing and raises no card', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/other.ts', 'export {};\n');
    const before = onOrigin(batch.branch);
    waitsForChecks(batch);
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));

    const now = await restartCi(batch);

    expect(onOrigin(batch.branch)).toBe(before);
    // The watch's notice says the checks never started; a card about conflicts would be wrong.
    expect(h.cards()).toEqual([]);
    expect(now.notices).toEqual([]);
    expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(before);
  });

  it('pushes nothing to a pull request held for the builder', async () => {
    h.close();
    h = createDeliveryHarness({ workspaceMode: 'worktree', landing: 'hold' }, { trigger: false });
    h.commit('src/index.ts', "import a from './a';\nexport {};\n");
    h.git$('push', '-q', 'origin', 'main');
    const batch = await shipped();
    h.teammatePush('main', 'src/other.ts', 'export {};\n');
    const before = onOrigin(batch.branch);
    waitsForChecks(batch);
    await restartCi(batch);
    expect(onOrigin(batch.branch)).toBe(before);
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
