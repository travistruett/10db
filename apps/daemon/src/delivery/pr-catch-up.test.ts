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
/** Whether a waiting update drains the factory. */
let draining: boolean;
beforeEach(() => {
  draining = false;
  // The tests settle work and ask the shipper themselves.
  h = createDeliveryHarness(
    { workspaceMode: 'worktree' },
    { trigger: false, holdShips: () => draining },
  );
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

  it.each([
    ['the worktree it kept', true],
    ['a worktree it made', false],
  ])(
    "keeps a builder's commit made in %s while the base update's install runs, when the check then fails",
    async (_where, keepWorktree) => {
      const batch = await shipped('src/index.ts', BOTH.mine, { keepWorktree });
      h.teammatePush('main', 'src/index.ts', BOTH.theirs);
      conflicts(batch);
      const branch = batch.branch ?? '';
      h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
      // The install after the merge reads the lockfile at HEAD: the builder commits in that window.
      const read = h.git.blobAt.bind(h.git);
      let committed = false;
      vi.spyOn(h.git, 'blobAt').mockImplementation(async (repo, rev, file) => {
        if (!committed && rev === 'HEAD' && file === 'pnpm-lock.yaml') {
          committed = true;
          await commitIn(getBatch(h.store.db, batch.id), 'src/builder.ts');
        }
        return read(repo, rev, file);
      });

      await catchUp(batch);

      expect(committed).toBe(true);
      const tip = h.git$('rev-parse', `refs/heads/${branch}`);
      expect(h.git$('show', `${tip}:src/builder.ts`)).toBe('src/builder.ts');
      expect(h.git$('log', '-1', '--format=%s', tip)).toBe('Add src/builder.ts');
      // Nothing was pushed, and the failed check still has its one card.
      expect(h.origin$('log', '-1', '--format=%s', onOrigin(branch))).not.toBe(
        'Add src/builder.ts',
      );
      expect(h.cards().filter((c) => c.title.includes('gate failed'))).toHaveLength(1);
    },
  );

  describe('when the merge takes the base copy of a generated directory, to regenerate', () => {
    const DB = 'packages/db/drizzle';

    /** A batch whose migration and main's both took number 0001; shipped, then main moved. */
    async function migrationsCollide(): Promise<BatchDto> {
      h.commit(
        'packages/db/package.json',
        `${JSON.stringify({ name: '@10db/db', scripts: { generate: 'drizzle-kit generate' } })}\n`,
      );
      h.commit(`${DB}/meta/_journal.json`, '["0000"]\n');
      h.commit(`${DB}/0000_init.sql`, 'create table a;\n');
      h.git$('push', '-q', 'origin', 'main');
      const batch = await shipped(`${DB}/meta/_journal.json`, '["0000","0001_mine"]\n', {
        keepWorktree: true,
      });
      h.teammatePush('main', `${DB}/meta/_journal.json`, '["0000","0001_theirs"]\n');
      h.teammatePush('main', `${DB}/0001_theirs.sql`, 'alter table a add c;\n');
      conflicts(batch);
      h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
      return batch;
    }

    /** A generator that writes what the merged sources would generate, and counts its runs. */
    function generating(run: { ran: number }, first?: () => Promise<void>): void {
      vi.spyOn(h.ctx.generators, 'regenerate').mockImplementation(async ({ path }) => {
        run.ran += 1;
        await first?.();
        writeFileSync(join(path, DB, 'meta/_journal.json'), '["0000","0001_theirs","0002_mine"]\n');
        return { kind: 'done', logPath: join(path, 'generate.log') };
      });
    }

    /** The branch's tip holds the builder's commit, which nothing pushed. */
    function builderKept(branch: string): void {
      const tip = h.git$('rev-parse', `refs/heads/${branch}`);
      expect(h.git$('log', '-1', '--format=%s', tip)).toBe('Add src/builder.ts');
      expect(h.git$('show', `${tip}:src/builder.ts`)).toBe('src/builder.ts');
      expect(h.origin$('log', '-1', '--format=%s', onOrigin(branch))).not.toBe(
        'Add src/builder.ts',
      );
    }

    it("keeps a builder's commit made while the install runs, when the check then fails", async () => {
      const batch = await migrationsCollide();
      const run = { ran: 0 };
      generating(run);
      const read = h.git.blobAt.bind(h.git);
      let committed = false;
      vi.spyOn(h.git, 'blobAt').mockImplementation(async (repo, rev, file) => {
        if (!committed && rev === 'HEAD' && file === 'pnpm-lock.yaml') {
          committed = true;
          await commitIn(getBatch(h.store.db, batch.id), 'src/builder.ts');
        }
        return read(repo, rev, file);
      });

      await catchUp(batch);

      expect(committed).toBe(true);
      builderKept(batch.branch ?? '');
    });

    it("pushes nothing and raises the one card, naming the migration, when the branch's can't be carried over", async () => {
      const journal = (...tags: string[]): string =>
        `${JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) })}\n`;
      const snapshot = (id: string, table: string): string =>
        `${JSON.stringify({ id, prevId: 'p', tables: [table] })}\n`;
      h.commit(
        'packages/db/package.json',
        `${JSON.stringify({ name: '@10db/db', scripts: { generate: 'drizzle-kit generate' } })}\n`,
      );
      h.commit(`${DB}/meta/_journal.json`, journal('0000_init'));
      h.commit(`${DB}/meta/0000_snapshot.json`, snapshot('s0', 'a'));
      h.git$('push', '-q', 'origin', 'main');
      const batch = await shipped(`${DB}/meta/_journal.json`, journal('0000_init', '0001_mine'), {
        keepWorktree: true,
      });
      await commitIn(batch, `${DB}/meta/0001_snapshot.json`, snapshot('s1', 'b'));
      h.git$('push', '-q', 'origin', `${batch.branch ?? ''}:${batch.branch ?? ''}`);
      h.teammatePush('main', `${DB}/meta/_journal.json`, journal('0000_init', '0001_theirs'));
      conflicts(batch);
      vi.spyOn(h.ctx.generators, 'regenerate').mockImplementation(({ path }) =>
        Promise.resolve({
          kind: 'failed',
          exitCode: 1,
          timedOut: false,
          tail: '',
          logPath: join(path, 'generate.log'),
        }),
      );
      const pushed = h.origin$('rev-parse', onOrigin(batch.branch));

      await catchUp(batch);

      expect(h.origin$('rev-parse', onOrigin(batch.branch))).toBe(pushed);
      // The fixture keeps the worktree, which has a card of its own.
      const cards = h.cards().filter((c) => !c.title.includes('kept the worktree'));
      expect(h.only(cards).title).toContain("couldn't update it");
      expect(h.only(cards).body).toContain('0001_mine');
    });

    describe('when the migration the merge dropped is never re-created', () => {
      const journal = (...tags: string[]): string =>
        `${JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) })}\n`;
      const snapshot = (id: string, table: string): string =>
        `${JSON.stringify({ id, prevId: 'p', tables: [table] })}\n`;

      /** A shipped batch and main that each added migration 0001; the worktree is kept, and no check runs. */
      async function bothAdded(): Promise<BatchDto> {
        h.commit(
          'packages/db/package.json',
          `${JSON.stringify({ name: '@10db/db', scripts: { generate: 'drizzle-kit generate' } })}\n`,
        );
        h.commit(`${DB}/meta/_journal.json`, journal('0000_init'));
        h.commit(`${DB}/meta/0000_snapshot.json`, snapshot('s0', 'a'));
        h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
        h.git$('push', '-q', 'origin', 'main');
        const batch = await shipped(`${DB}/meta/_journal.json`, journal('0000_init', '0001_mine'), {
          keepWorktree: true,
        });
        await commitIn(batch, `${DB}/meta/0001_snapshot.json`, snapshot('s1', 'b'));
        await commitIn(batch, `${DB}/0001_mine.sql`, 'update a;\n');
        h.git$('push', '-q', 'origin', `${batch.branch ?? ''}:${batch.branch ?? ''}`);
        h.teammatePush('main', `${DB}/meta/_journal.json`, journal('0000_init', '0001_theirs'));
        h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\n# changed\n');
        conflicts(batch);
        h.state.write((c) => patchProject(c, h.project.id, { gateCommand: null }));
        return batch;
      }

      async function pushedNothing(batch: BatchDto, why?: string): Promise<void> {
        const pushed = onOrigin(batch.branch);

        await catchUp(batch);

        expect(onOrigin(batch.branch)).toBe(pushed);
        expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(pushed);
        // The fixture keeps the worktree, which has a card of its own.
        const card = h.only(h.cards().filter((c) => !c.title.includes('kept the worktree')));
        expect(card.title).toContain("couldn't update it");
        expect(card.body).toContain('0001_mine');
        if (why !== undefined) expect(card.body).toContain(why);
      }

      it('pushes nothing when the install the merged lockfile needs fails', async () => {
        const batch = await bothAdded();
        vi.spyOn(h.ctx.dependencies, 'refresh').mockRejectedValue(new Error('the install failed'));

        await pushedNothing(batch, 'the install the merged lockfile needs failed');
      });

      it('pushes nothing when the generators throw', async () => {
        const batch = await bothAdded();
        vi.spyOn(h.ctx.generators, 'regenerate').mockRejectedValue(new Error('no sandbox'));

        await pushedNothing(batch, 'no sandbox');
      });

      it('pushes nothing when the worktree is dirty, so the generators never start', async () => {
        const batch = await bothAdded();
        const regenerate = vi.spyOn(h.ctx.generators, 'regenerate');
        writeFileSync(join(batch.worktreePath ?? '', 'src/index.ts'), 'in progress\n');

        await pushedNothing(batch, 'uncommitted changes');

        expect(regenerate).not.toHaveBeenCalled();
      });

      it('pushes nothing when the install in the copy is broken', async () => {
        const batch = await bothAdded();
        // The merged lockfile names a package no install brings.
        h.teammatePush(
          'main',
          'pnpm-lock.yaml',
          "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n",
        );
        mkdirSync(join(batch.worktreePath ?? '', 'node_modules'), { recursive: true });

        await pushedNothing(batch, 'install');
      });
    });

    it("keeps a builder's commit made while the generators run, when the check then fails", async () => {
      const batch = await migrationsCollide();
      const run = { ran: 0 };
      generating(run, () => commitIn(getBatch(h.store.db, batch.id), 'src/builder.ts'));

      await catchUp(batch);

      expect(run.ran).toBe(1);
      builderKept(batch.branch ?? '');
    });
  });

  it("keeps a builder's commit made in the kept worktree while the check runs, when it then fails", async () => {
    const batch = await shipped('src/index.ts', BOTH.mine, { keepWorktree: true });
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    const branch = batch.branch ?? '';
    const kept = batch.worktreePath ?? '';
    // The check fails after the builder commits in the worktree; it runs there.
    h.state.write((c) =>
      patchProject(c, h.project.id, {
        gateCommand: `git -c user.name=Builder -c user.email=builder@example.com commit -q --allow-empty -m 'Fix by hand' && false`,
      }),
    );

    await catchUp(batch);

    const tip = h.git$('rev-parse', `refs/heads/${branch}`);
    expect(h.git$('log', '-1', '--format=%s', tip)).toBe('Fix by hand');
    expect(h.git$('-C', kept, 'rev-parse', 'HEAD')).toBe(tip);
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

  it("names only the builder's commit, and 10db's own unpushed merge as 10db's, in the kept worktree", async () => {
    const batch = await shipped('src/index.ts', BOTH.mine, { keepWorktree: true });
    const kept = batch.worktreePath ?? '';
    const branch = batch.branch ?? '';
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
    // A round's merge of main fails its check and can't be put back: it stays in the kept worktree, unpushed.
    vi.spyOn(h.git, 'rewindBranch').mockRejectedValueOnce(new Error('index.lock exists'));
    await catchUp(batch);
    const merge = h.git$('rev-parse', `refs/heads/${branch}`);
    expect(merge).not.toBe(onOrigin(branch));
    expect(h.git$('log', '-1', '--format=%P', merge).split(' ')).toHaveLength(2);

    // The builder commits on top of that merge in the kept worktree.
    await commitIn(getBatch(h.store.db, batch.id), 'src/mine.ts');
    const builders = h.git$('rev-parse', `refs/heads/${branch}`);
    expect(builders).not.toBe(merge);
    h.shipClock.advance(31 * 60_000);

    await catchUp(getBatch(h.store.db, batch.id));

    expect(h.git$('rev-parse', `refs/heads/${branch}`)).toBe(builders);
    const card = h.only(h.cards().filter((c) => c.body.includes('lacks')));
    // Listed as the commit 10db did not write: the builder's alone.
    expect(card.body).toContain(`(${builders.slice(0, 7)})`);
    // The merge is named as 10db's own, not among the commits the builder is asked to push.
    expect(card.body).toContain(`10db's own unpushed merge ${merge.slice(0, 7)}`);
    expect(card.body).not.toContain(`(${merge.slice(0, 7)}`);
    expect(card.body).not.toContain(`, ${merge.slice(0, 7)}`);
    // Pushing the builder's commit would push the merge under it: the card moves it onto the head first.
    const head = onOrigin(branch);
    expect(card.body).toContain(
      `git rebase --onto ${head.slice(0, 7)} ${merge.slice(0, 7)} ${branch}`,
    );
    expect(card.body).not.toContain('Push it to the pull request');
    expect(kept).not.toBe('');
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

  // A push takes a pull request out of its base's merge queue. The watch read it a round ago, and
  // the queue may have taken it since, so the job reads the queue itself before it pushes anything.
  it('pushes nothing to a pull request that is in the merge queue, nor when the queue cannot be read', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = onOrigin(batch.branch);
    const url = conflicts(batch);
    h.gh.setInMergeQueue(url, true);
    const now = await catchUp(batch);
    expect(onOrigin(batch.branch)).toBe(before);
    expect(h.cards()).toEqual([]);
    expect(now.notices).toEqual([]);
    expect(h.gh.calls.some((c) => c.method === 'prInMergeQueue')).toBe(true);

    h.gh.setInMergeQueue(url, false);
    h.gh.failQueueRead.set(url, new GhError('failed', 'HTTP 502'));
    await catchUp(batch);
    expect(onOrigin(batch.branch)).toBe(before);
    expect(h.cards()).toEqual([]);

    // Out of the queue and readable, the same pull request is caught up.
    h.gh.failQueueRead.delete(url);
    await catchUp(batch);
    expect(onOrigin(batch.branch)).not.toBe(before);
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

describe('a catch-up while a waiting update drains the factory', () => {
  /** A shipped pull request that conflicts with main, as the drain begins. */
  async function conflictingAsItDrains() {
    const batch = await shipped();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    draining = true;
    return { batch, before: onOrigin(batch.branch) };
  }

  it.each([
    [
      'the base into a conflicting pull request',
      (batch: BatchDto) => {
        h.shipper.catchUp(batch.id);
      },
    ],
    [
      'the base into a pull request whose checks never started',
      (batch: BatchDto) => {
        // Held: it says so, and the watch keeps the ask unasked.
        expect(h.shipper.restartCi(batch.id)).toBe(false);
      },
    ],
  ])('starts no gate to bring %s', async (_name, ask) => {
    const { batch, before } = await conflictingAsItDrains();
    ask(batch);
    expect(h.jobs.pending()).toBe(0);
    await h.jobs.idle();
    expect(onOrigin(batch.branch)).toBe(before);
  });

  it('brings the base in when the next round asks, once the drain has ended', async () => {
    const { batch, before } = await conflictingAsItDrains();
    await catchUp(batch);
    expect(onOrigin(batch.branch)).toBe(before);
    draining = false;
    await catchUp(batch);
    expect(onOrigin(batch.branch)).not.toBe(before);
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

  it('pushes nothing to a pull request in the merge queue, which reads BLOCKED with no checks', async () => {
    const batch = await shipped();
    h.teammatePush('main', 'src/other.ts', 'export {};\n');
    const before = onOrigin(batch.branch);
    const url = waitsForChecks(batch);
    h.gh.setInMergeQueue(url, true);

    const now = await restartCi(batch);

    expect(onOrigin(batch.branch)).toBe(before);
    expect(now.notices).toEqual([]);
    expect(h.cards()).toEqual([]);
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
