import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchDto } from '@10db/contracts';
import { getBatch, patchBatch, patchProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { commitIn, committed, pathOf, shipped } from '../../test/delivery-worlds';
import { GhError, PrMergeable } from '../github';
import { NOTICE_KEY } from './notices';

// Each case builds a real repository, a worktree, a push and a teammate's push.
vi.setConfig({ testTimeout: 120_000 });
/** A test that loops over rows builds a fresh repository for each row. */
const ROWS_TIMEOUT = 600_000;

let h: DeliveryHarness;
/** Whether a waiting update drains the factory. */
let draining: boolean;

/** A fresh harness whose main holds src/index.ts, pushed. */
function boot(project: { readonly landing?: 'hold' } = {}): void {
  draining = false;
  // The tests settle work and ask the shipper themselves.
  h = createDeliveryHarness(
    { workspaceMode: 'worktree', ...project },
    { trigger: false, holdShips: () => draining },
  );
  h.commit('src/index.ts', "import a from './a';\nexport {};\n");
  h.git$('push', '-q', 'origin', 'main');
}

/** Drops this row's harness and builds the next row a fresh one. */
function reboot(project: { readonly landing?: 'hold' } = {}): void {
  h.close();
  boot(project);
}

beforeEach(() => {
  boot();
});
afterEach(() => {
  h.close();
});

const BOTH = {
  mine: "import a from './a';\nimport b from './b';\nexport {};\n",
  theirs: "import a from './a';\nimport c from './c';\nexport {};\n",
};

/** The SHA of `branch` on origin; throws when origin doesn't have it. */
const tipOnOrigin = (branch: string | null): string =>
  h.origin$('rev-parse', '--verify', '-q', `refs/heads/${branch ?? ''}`);

/** Ships one task that wrote `path`; resolves with the SHIPPED batch. */
async function shippedWith(
  path = 'src/index.ts',
  content = BOTH.mine,
  opts: { readonly keepWorktree?: boolean } = {},
): Promise<BatchDto> {
  const world = await committed(h, { path, content });
  if (opts.keepWorktree) {
    // A hand-made, git-ignored .env 10db didn't seed: the worktree stays after the ship.
    writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.env\n');
    writeFileSync(join(pathOf(world.batch), '.env'), 'SECRET=1\n');
  }
  return (await shipped(h, { from: world })).batch;
}

/** GitHub now says the pull request conflicts with main, at the branch's tip on origin. */
function conflicts(batch: BatchDto): string {
  const url = batch.prUrl ?? '';
  h.gh.setHead(url, tipOnOrigin(batch.branch));
  h.gh.setMergeBlocked(url, 'conflicts');
  h.gh.setMergeable(url, PrMergeable.Conflicting);
  return url;
}

async function catchUp(batch: BatchDto): Promise<BatchDto> {
  h.shipper.catchUp(batch.id);
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

/** The card is raised before the rewind, which may leave the merge where it is. */
const SAYS_PUT_BACK = /put (its|the) merge back|merge (was|is) put back/;

/** The builder commits while the install reads the merged lockfile at HEAD, before the generators. */
const commitsDuringInstall = (batch: BatchDto): (() => boolean) => {
  const read = h.git.blobAt.bind(h.git);
  let committed = false;
  vi.spyOn(h.git, 'blobAt').mockImplementation(async (repo, rev, file) => {
    if (!committed && rev === 'HEAD' && file === 'pnpm-lock.yaml') {
      committed = true;
      await commitIn(h, getBatch(h.store.db, batch.id), 'src/builder.ts');
    }
    return read(repo, rev, file);
  });
  return () => committed;
};

describe('a shipped pull request that conflicts with its base', () => {
  it('pushes nothing while GitHub reads it clean, it is in the merge queue or the queue cannot be read, lists the settled files when the pre-check fails, then has the base merged in, settled conflicts named, pushed, and no card', async () => {
    const batch = await shippedWith();
    // No merge was refused, so a retry asks GitHub nothing.
    const calls = h.gh.calls.length;
    h.shipper.retryMerge(batch.id);
    await h.jobs.idle();
    expect(h.gh.calls).toHaveLength(calls);

    const teammate = h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = tipOnOrigin(batch.branch);
    // GitHub says clean (the default): nothing to do.
    let now = await catchUp(batch);
    expect(tipOnOrigin(batch.branch)).toBe(before);
    expect(now.notices).toEqual([]);

    // A push takes a pull request out of its base's merge queue. The watch read it a round ago, and
    // the queue may have taken it since, so the job reads the queue itself before it pushes anything.
    const url = conflicts(batch);
    h.gh.setInMergeQueue(url, true);
    now = await catchUp(batch);
    expect(tipOnOrigin(batch.branch)).toBe(before);
    expect(h.cards()).toEqual([]);
    expect(now.notices).toEqual([]);
    expect(h.gh.calls.some((c) => c.method === 'prInMergeQueue')).toBe(true);

    h.gh.setInMergeQueue(url, false);
    h.gh.failQueueRead.set(url, new GhError('failed', 'HTTP 502'));
    await catchUp(batch);
    expect(tipOnOrigin(batch.branch)).toBe(before);
    expect(h.cards()).toEqual([]);

    // Out of the queue and readable, the same pull request is caught up: the pre-check fails on the result.
    h.gh.failQueueRead.delete(url);
    h.state.write((c) =>
      patchProject(c, h.project.id, { gateCommand: 'true', precheckCommand: 'false' }),
    );
    await catchUp(batch);
    expect(tipOnOrigin(batch.branch)).toBe(before);
    const card = h.only(h.cards());
    expect(card.title).toContain('pre-check failed');
    expect(card.body).toContain('10db settled these files itself in the merge');
    expect(card.body).toContain('src/index.ts');

    // The check is fixed and the retry time passes.
    h.state.write((c) =>
      patchProject(c, h.project.id, {
        gateCommand: h.project.gateCommand,
        precheckCommand: h.project.precheckCommand,
      }),
    );
    h.shipClock.advance(31 * 60_000);
    now = await catchUp(getBatch(h.store.db, batch.id));

    const tip = tipOnOrigin(batch.branch);
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

  describe('when the packages of the copy it merges in do not resolve', () => {
    const GENERATED = 'packages/contracts/generated';

    /** Main's lockfile names left-pad, which every copy's install makes until `pruned` removes it. */
    function installable(): void {
      h.commit('.gitignore', 'node_modules/\n');
      h.commit(
        'pnpm-lock.yaml',
        [
          'importers:',
          '  .:',
          '    dependencies:',
          '      left-pad:',
          '        specifier: 1.3.0',
          '        version: 1.3.0',
          '',
        ].join('\n'),
      );
      h.git$('push', '-q', 'origin', 'main');
      mkdirSync(join(h.repo, 'node_modules', 'left-pad'), { recursive: true });
      // A pnpm copy's node_modules comes from its own install, not from the checkout's.
      h.pnpm.makes({ 'node_modules/left-pad/index.js': 'module.exports = 1;\n' });
    }

    /** No install brings left-pad back now: the copy's own install lacks it too. */
    function pruned(batch: BatchDto): void {
      h.pnpm.makesNothing();
      rmSync(join(h.repo, 'node_modules', 'left-pad'), { recursive: true });
      if (batch.worktreePath !== null)
        rmSync(join(batch.worktreePath, 'node_modules', 'left-pad'), {
          recursive: true,
          force: true,
        });
    }

    it(
      'pushes nothing, raises one card naming the install and puts the merge back, with no check or with a gate set',
      async () => {
        const rows = [
          ['no check is set', null],
          ['a gate is set', { gateCommand: 'touch gate-ran' }],
        ] as const;
        for (const [i, [name, project]] of rows.entries()) {
          if (i > 0) reboot();
          installable();
          const batch = await shippedWith('src/index.ts', BOTH.mine, { keepWorktree: true });
          const kept = batch.worktreePath ?? '';
          h.teammatePush('main', 'src/index.ts', BOTH.theirs);
          conflicts(batch);
          const before = tipOnOrigin(batch.branch);
          if (project !== null) h.state.write((c) => patchProject(c, h.project.id, project));
          pruned(batch);

          const now = await catchUp(batch);

          expect.soft(tipOnOrigin(batch.branch), name).toBe(before);
          expect.soft(existsSync(join(kept, 'gate-ran')), name).toBe(false);
          // (The kept worktree has its own card, from the ship.)
          const card = h.only(h.cards().filter((c) => c.title.includes('conflicts with main')));
          expect.soft(card.body, name).toContain('.: left-pad');
          expect.soft(card.body, name).toContain('nothing was pushed');
          // This merge took no generated directory, so the card speaks of none.
          expect.soft(card.body, name).not.toContain('regenerated');
          // The kept lines are named, with no commit to find them in and no word on where the merge is.
          expect.soft(card.body, name).toContain("src/index.ts (kept both sides' added lines)");
          expect.soft(card.body, name).not.toContain('The merge commit lists them');
          expect.soft(card.body, name).not.toMatch(SAYS_PUT_BACK);
          expect
            .soft(
              now.notices.map((n) => n.key),
              name,
            )
            .not.toContain('pull-request-update');
          expect.soft(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`), name).toBe(before);
          expect.soft(h.git$('-C', kept, 'rev-parse', 'HEAD'), name).toBe(before);
        }
      },
      ROWS_TIMEOUT,
    );

    it('raises the one card, naming the generated directory it did not regenerate, and puts the merge back', async () => {
      installable();
      h.commit(
        'packages/contracts/package.json',
        `${JSON.stringify({ name: '@10db/contracts', scripts: { generate: 'tsx generate.ts' } })}\n`,
      );
      h.commit(`${GENERATED}/a.schema.json`, '{"v":0}\n');
      h.git$('push', '-q', 'origin', 'main');
      const batch = await shippedWith(`${GENERATED}/a.schema.json`, '{"v":"mine"}\n');
      h.teammatePush('main', `${GENERATED}/a.schema.json`, '{"v":"theirs"}\n');
      conflicts(batch);
      const before = tipOnOrigin(batch.branch);
      h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
      pruned(batch);
      const generators = vi.spyOn(h.ctx.generators, 'regenerate');

      const now = await catchUp(batch);

      expect(generators).not.toHaveBeenCalled();
      expect(tipOnOrigin(batch.branch)).toBe(before);
      expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(before);
      const card = h.only(h.cards());
      expect(card.title).toContain("conflicts with main and 10db couldn't update it");
      expect(card.body).toContain('.: left-pad');
      expect(card.body).toContain(`${GENERATED}/ could not be regenerated`);
      // The merge was put back and the directory was never regenerated, so the card says neither was done.
      expect(card.body).not.toContain('regenerated from its sources');
      expect(card.body).not.toContain('The merge commit lists them');
      expect(now.worktreePath).toBeNull();
      expect(
        h.logs
          .lines()
          .filter((l) => l['msg'] === 'generated files not regenerated after the base merged'),
      ).toHaveLength(1);
    });

    describe('when the generators of a merged generated directory report a problem', () => {
      /** The batch and main changed one generated file, and main's lockfile moved; the worktree is the catch-up's own. */
      async function generatedConflict(
        gateCommand: string | null,
        keepWorktree: boolean,
      ): Promise<BatchDto> {
        h.commit(
          'packages/contracts/package.json',
          `${JSON.stringify({ name: '@10db/contracts', scripts: { generate: 'tsx generate.ts' } })}\n`,
        );
        h.commit(`${GENERATED}/a.schema.json`, '{"v":0}\n');
        h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
        h.git$('push', '-q', 'origin', 'main');
        const batch = await shippedWith(`${GENERATED}/a.schema.json`, '{"v":"mine"}\n', {
          keepWorktree,
        });
        h.teammatePush('main', `${GENERATED}/a.schema.json`, '{"v":"theirs"}\n');
        h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\n# changed\n');
        conflicts(batch);
        h.state.write((c) => patchProject(c, h.project.id, { gateCommand }));
        return batch;
      }

      const failing = (): void => {
        vi.spyOn(h.ctx.generators, 'regenerate').mockImplementation(({ path }) =>
          Promise.resolve({
            kind: 'failed',
            exitCode: 1,
            timedOut: false,
            tail: '',
            logPath: join(path, 'generate.log'),
          }),
        );
      };

      const unchanged = (): void => {
        vi.spyOn(h.ctx.generators, 'regenerate').mockImplementation(({ path }) =>
          Promise.resolve({ kind: 'done', logPath: join(path, 'generate.log') }),
        );
      };

      const installFails = (): void => {
        vi.spyOn(h.ctx.dependencies, 'refresh').mockRejectedValue(new Error('the install failed'));
      };

      // A failed install is met in the worktree 10db makes too, so that case keeps the batch's own.
      const PROBLEMS = [
        ['the generators exit non-zero', 'regenerating them failed (exit 1)', failing, false],
        ['the generators change nothing', 'regenerating changed nothing', unchanged, false],
        [
          'the install the merged lockfile needs fails',
          'the install the merged lockfile needs failed',
          installFails,
          true,
        ],
      ] as const;
      const CHECKS = [
        ['no check is set', null],
        ['a gate is set', 'true'],
      ] as const;

      it(
        'pushes nothing, puts the merge back and raises one card when the generators fail or change nothing or the install fails, with no check or a gate',
        async () => {
          const rows = PROBLEMS.flatMap(([problem, why, setUp, kept]) =>
            CHECKS.map(
              ([check, gateCommand]) =>
                [`${problem} and ${check}`, why, setUp, kept, gateCommand] as const,
            ),
          );
          for (const [i, [name, why, setUp, kept, gateCommand]] of rows.entries()) {
            if (i > 0) reboot();
            const batch = await generatedConflict(gateCommand, kept);
            setUp();
            const before = tipOnOrigin(batch.branch);

            const now = await catchUp(batch);

            expect.soft(tipOnOrigin(batch.branch), name).toBe(before);
            expect.soft(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`), name).toBe(before);
            // (A kept worktree has its own card, from the ship.)
            const card = h.only(h.cards().filter((c) => !c.title.includes('kept the worktree')));
            expect
              .soft(card.title, name)
              .toContain("conflicts with main and 10db couldn't update it");
            expect.soft(card.body, name).toContain(why);
            expect.soft(card.body, name).toContain(`${GENERATED}/`);
            expect.soft(card.body, name).not.toContain('regenerated from its sources');
            expect.soft(card.body, name).not.toMatch(SAYS_PUT_BACK);
            // The worktree the catch-up made is gone, and no card tells the builder to regenerate in it.
            if (!kept) expect.soft(now.worktreePath, name).toBeNull();
            expect.soft(card.body, name).not.toContain('Regenerate them in the worktree');
            expect
              .soft(
                now.notices.map((n) => n.key),
                name,
              )
              .not.toContain('pull-request-update');
          }
        },
        ROWS_TIMEOUT,
      );

      /** The builder commits while the generators run. */
      const commitsDuringGenerators = (batch: BatchDto): (() => boolean) => {
        let committed = false;
        vi.spyOn(h.ctx.generators, 'regenerate').mockImplementation(async ({ path }) => {
          committed = true;
          await commitIn(h, getBatch(h.store.db, batch.id), 'src/builder.ts');
          return { kind: 'done', logPath: join(path, 'generate.log') };
        });
        return () => committed;
      };

      it(
        "keeps a builder's commit made during the install or the generators and does not say the merge went back",
        async () => {
          const rows = [
            ['the install, kept worktree, no check', commitsDuringInstall, true, null],
            ['the install, made worktree, a gate', commitsDuringInstall, false, 'true'],
            ['the generators, kept worktree, a gate', commitsDuringGenerators, true, 'true'],
            ['the generators, made worktree, no check', commitsDuringGenerators, false, null],
          ] as const;
          for (const [i, [name, commits, keepWorktree, gateCommand]] of rows.entries()) {
            if (i > 0) reboot();
            const batch = await generatedConflict(gateCommand, keepWorktree);
            const branch = batch.branch ?? '';
            const before = tipOnOrigin(branch);
            const committed = commits(batch);

            await catchUp(batch);

            expect.soft(committed(), name).toBe(true);
            const tip = h.git$('rev-parse', `refs/heads/${branch}`);
            expect.soft(h.git$('log', '-1', '--format=%s', tip), name).toBe('Add src/builder.ts');
            expect.soft(tipOnOrigin(branch), name).toBe(before);
            // (A kept worktree has its own card, from the ship.)
            const card = h.only(h.cards().filter((c) => !c.title.includes('kept the worktree')));
            expect.soft(card.body, name).toContain('the branch moved to');
            expect.soft(card.body, name).toContain('nothing was pushed');
            expect.soft(card.body, name).not.toMatch(SAYS_PUT_BACK);
          }
        },
        ROWS_TIMEOUT,
      );
    });

    it('raises no card when the branch holds the base, since there is no merge to stop', async () => {
      installable();
      const batch = await shippedWith();
      conflicts(batch);
      const before = tipOnOrigin(batch.branch);
      pruned(batch);

      await catchUp(batch);

      expect(tipOnOrigin(batch.branch)).toBe(before);
      expect(h.cards()).toEqual([]);
      expect(
        h.logs
          .lines()
          .filter((l) => l['msg'] === 'pull request conflicts but its branch holds the base'),
      ).toHaveLength(1);
    });
  });

  it('puts the local branch back at the pull request head when the check fails in the worktree it kept, then merges the base there and keeps it', async () => {
    const batch = await shippedWith('src/index.ts', BOTH.mine, { keepWorktree: true });
    const kept = batch.worktreePath ?? '';
    expect(kept).not.toBe('');
    const teammate = h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    const before = tipOnOrigin(batch.branch);
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));

    await catchUp(batch);

    expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(before);
    expect(h.git$('-C', kept, 'rev-parse', 'HEAD')).toBe(before);
    expect(h.git$('-C', kept, 'status', '--porcelain')).toBe('');
    expect(h.git$('-C', kept, 'show', 'HEAD:src/index.ts')).toBe(BOTH.mine.trimEnd());

    // The check is fixed and the retry time passes.
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: h.project.gateCommand }));
    h.shipClock.advance(31 * 60_000);
    const now = await catchUp(getBatch(h.store.db, batch.id));

    const tip = tipOnOrigin(batch.branch);
    expect(h.origin$('log', '-1', '--format=%P', tip)).toBe(`${before} ${teammate}`);
    expect(now.notices.map((n) => n.key)).toEqual(['pull-request-update']);
    expect(h.cards().filter((c) => c.title.includes('conflicts with main'))).toEqual([]);
    // The kept worktree is still there and still named, with the builder's file in it.
    expect(now.worktreePath).toBe(kept);
    expect(existsSync(join(kept, '.env'))).toBe(true);
    expect(h.git$('-C', kept, 'rev-parse', 'HEAD')).toBe(tip);
  });

  it('runs the gate on the merged branch before it pushes, and catches up again after the failed check and the builder updating the branch on GitHub', async () => {
    const batch = await shippedWith();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const url = conflicts(batch);
    const branch = batch.branch ?? '';
    const before = tipOnOrigin(branch);
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
    const failed = await catchUp(batch);
    expect(tipOnOrigin(branch)).toBe(before);
    const card = h.only(h.cards());
    expect(card.title).toContain('gate failed');
    expect(card.body).toContain('main');
    expect(failed.notices.map((n) => n.key)).not.toContain('pull-request-update');
    expect(failed.worktreePath).toBeNull();
    // 10db's merge, which it did not push, is not left on the local branch.
    expect(h.git$('rev-parse', `refs/heads/${branch}`)).toBe(before);

    // The builder presses Update branch: GitHub's head gains a commit the local branch lacks.
    const byHand = h.origin$(
      '-c',
      'user.name=Builder',
      '-c',
      'user.email=builder@example.com',
      'commit-tree',
      `refs/heads/${branch}^{tree}`,
      '-p',
      tipOnOrigin(branch),
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
    expect(h.origin$('log', '-1', '--format=%P', tipOnOrigin(branch)).split(' ')[0]).toBe(byHand);
  });

  it('starts from the pull request head when the local branch holds an earlier unpushed merge of 10db', async () => {
    const batch = await shippedWith();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const url = conflicts(batch);
    const branch = batch.branch ?? '';
    const head = tipOnOrigin(branch);
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
    // An earlier catch-up's merge of main fails its check and can't be put back: it stays, unpushed.
    vi.spyOn(h.git, 'rewindBranch').mockRejectedValueOnce(new Error('index.lock exists'));
    await catchUp(batch);
    const stale = h.git$('rev-parse', `refs/heads/${branch}`);
    expect(h.git$('log', '-1', '--format=%P', stale).split(' ')).toHaveLength(2);
    expect(tipOnOrigin(branch)).toBe(head);

    // Its retry time passes, and the next catch-up starts from the head again.
    h.shipClock.advance(31 * 60_000);
    await catchUp(getBatch(h.store.db, batch.id));

    expect(h.git$('rev-parse', `refs/heads/${branch}`)).toBe(head);
    expect(h.cards().filter((c) => c.body.includes('lacks'))).toEqual([]);
    expect(tipOnOrigin(branch)).toBe(head);

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
    expect(h.origin$('log', '-1', '--format=%P', tipOnOrigin(branch)).split(' ')[0]).toBe(byHand);
  });

  it(
    "keeps a builder's local commit, or the builder's own merge of main, ahead of the pull request head and raises a card naming it",
    async () => {
      const BUILDER = ['-c', 'user.name=Builder', '-c', 'user.email=builder@example.com'];
      const rows: [string, (head: string) => string][] = [
        // A hand commit on the local branch, never pushed: not a merge of 10db's.
        [
          'a hand commit',
          (head) =>
            h.git$(...BUILDER, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'Fix by hand'),
        ],
        // The builder runs `git merge origin/main` and settles the conflict by hand, not yet pushed.
        [
          "the builder's merge of main",
          (head) => {
            h.git$('fetch', '-q', 'origin');
            return h.git$(
              ...BUILDER,
              'commit-tree',
              `${head}^{tree}`,
              '-p',
              head,
              '-p',
              'origin/main',
              '-m',
              "Merge branch 'main'",
            );
          },
        ],
      ];
      for (const [i, [name, commit]] of rows.entries()) {
        if (i > 0) reboot();
        const batch = await shippedWith();
        h.teammatePush('main', 'src/index.ts', BOTH.theirs);
        conflicts(batch);
        const branch = batch.branch ?? '';
        const head = tipOnOrigin(branch);
        const byHand = commit(head);
        h.git$('update-ref', `refs/heads/${branch}`, byHand, head);

        await catchUp(batch);

        expect.soft(h.git$('rev-parse', `refs/heads/${branch}`), name).toBe(byHand);
        expect.soft(tipOnOrigin(branch), name).toBe(head);
        const card = h.only(h.cards());
        expect.soft(card.body, name).toContain(byHand.slice(0, 7));
      }
    },
    ROWS_TIMEOUT,
  );

  it('keeps an unpushed merge of 10db after a restart and raises a card naming it', async () => {
    const batch = await shippedWith();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    const branch = batch.branch ?? '';
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
    vi.spyOn(h.git, 'rewindBranch').mockRejectedValueOnce(new Error('index.lock exists'));
    await catchUp(batch);
    const stale = h.git$('rev-parse', `refs/heads/${branch}`);
    expect(stale).not.toBe(tipOnOrigin(branch));

    // The daemon restarts: what it knew of its own merge is gone.
    h.restartShipper();
    await catchUp(getBatch(h.store.db, batch.id));

    expect(h.git$('rev-parse', `refs/heads/${branch}`)).toBe(stale);
    const card = h.only(h.cards());
    expect(card.body).toContain(stale.slice(0, 7));
  });

  it(
    "keeps a builder's commit made in the worktree it kept or one it made while the base update's install runs, when the check then fails",
    async () => {
      const rows = [
        ['the worktree it kept', true],
        ['a worktree it made', false],
      ] as const;
      for (const [i, [name, keepWorktree]] of rows.entries()) {
        if (i > 0) reboot();
        const batch = await shippedWith('src/index.ts', BOTH.mine, { keepWorktree });
        h.teammatePush('main', 'src/index.ts', BOTH.theirs);
        conflicts(batch);
        const branch = batch.branch ?? '';
        h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
        // The install after the merge reads the lockfile at HEAD: the builder commits in that window.
        const committed = commitsDuringInstall(batch);

        await catchUp(batch);

        expect.soft(committed(), name).toBe(true);
        const tip = h.git$('rev-parse', `refs/heads/${branch}`);
        expect.soft(h.git$('show', `${tip}:src/builder.ts`), name).toBe('src/builder.ts');
        expect.soft(h.git$('log', '-1', '--format=%s', tip), name).toBe('Add src/builder.ts');
        // Nothing was pushed, and the failed check still has its one card.
        expect
          .soft(h.origin$('log', '-1', '--format=%s', tipOnOrigin(branch)), name)
          .not.toBe('Add src/builder.ts');
        expect
          .soft(
            h.cards().filter((c) => c.title.includes('gate failed')),
            name,
          )
          .toHaveLength(1);
      }
    },
    ROWS_TIMEOUT,
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
      const batch = await shippedWith(`${DB}/meta/_journal.json`, '["0000","0001_mine"]\n', {
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
    function builderKept(branch: string, label: string): void {
      const tip = h.git$('rev-parse', `refs/heads/${branch}`);
      expect.soft(h.git$('log', '-1', '--format=%s', tip), label).toBe('Add src/builder.ts');
      expect.soft(h.git$('show', `${tip}:src/builder.ts`), label).toBe('src/builder.ts');
      expect
        .soft(h.origin$('log', '-1', '--format=%s', tipOnOrigin(branch)), label)
        .not.toBe('Add src/builder.ts');
    }

    it(
      "keeps a builder's commit made while the install or the generators run, when the check then fails",
      async () => {
        const rows: [string, (batch: BatchDto, run: { ran: number }) => () => void][] = [
          [
            'during the install',
            (batch, run) => {
              generating(run);
              const committed = commitsDuringInstall(batch);
              return () => {
                expect.soft(committed(), 'during the install').toBe(true);
              };
            },
          ],
          [
            'during the generators',
            (batch, run) => {
              generating(run, async () => {
                await commitIn(h, getBatch(h.store.db, batch.id), 'src/builder.ts');
              });
              return () => {
                expect.soft(run.ran, 'during the generators').toBe(1);
              };
            },
          ],
        ];
        for (const [i, [name, setUp]] of rows.entries()) {
          if (i > 0) reboot();
          const batch = await migrationsCollide();
          const checkRun = setUp(batch, { ran: 0 });

          await catchUp(batch);

          checkRun();
          builderKept(batch.branch ?? '', name);
        }
      },
      ROWS_TIMEOUT,
    );

    it(
      'raises no regenerate card, and puts its merge back, when it is stopped after the merge or the daemon stops during the install',
      async () => {
        const rows: [string, () => () => void][] = [
          [
            'stopped after the merge',
            () => {
              vi.spyOn(h.ctx.generators, 'regenerate').mockResolvedValue({ kind: 'aborted' });
              return () => undefined;
            },
          ],
          [
            'the daemon stops during the install',
            () => {
              const run = { ran: 0 };
              generating(run);
              // The install reads the lockfile at HEAD after the merge: the stop comes in that window.
              const read = h.git.blobAt.bind(h.git);
              let stopped = false;
              vi.spyOn(h.git, 'blobAt').mockImplementation((repo, rev, file) => {
                if (!stopped && rev === 'HEAD' && file === 'pnpm-lock.yaml') {
                  stopped = true;
                  void h.jobs.stop();
                }
                return read(repo, rev, file);
              });
              return () => {
                expect.soft(stopped, 'the daemon stops during the install').toBe(true);
                expect.soft(run.ran, 'the daemon stops during the install').toBe(0);
              };
            },
          ],
        ];
        for (const [i, [name, setUp]] of rows.entries()) {
          if (i > 0) reboot();
          const batch = await migrationsCollide();
          const checkRun = setUp();
          const pushed = tipOnOrigin(batch.branch);

          await catchUp(batch);

          checkRun();
          expect.soft(tipOnOrigin(batch.branch), name).toBe(pushed);
          // The merge is not left for the next catch-up to take for a commit 10db did not write.
          expect.soft(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`), name).toBe(pushed);
          // The fixture keeps the worktree, which has a card of its own.
          expect
            .soft(
              h.cards().filter((c) => !c.title.includes('kept the worktree')),
              name,
            )
            .toEqual([]);
        }
      },
      ROWS_TIMEOUT,
    );

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
      const batch = await shippedWith(
        `${DB}/meta/_journal.json`,
        journal('0000_init', '0001_mine'),
        {
          keepWorktree: true,
        },
      );
      await commitIn(h, batch, `${DB}/meta/0001_snapshot.json`, snapshot('s1', 'b'));
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
      const pushed = h.origin$('rev-parse', tipOnOrigin(batch.branch));

      await catchUp(batch);

      expect(h.origin$('rev-parse', tipOnOrigin(batch.branch))).toBe(pushed);
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
        const batch = await shippedWith(
          `${DB}/meta/_journal.json`,
          journal('0000_init', '0001_mine'),
          {
            keepWorktree: true,
          },
        );
        await commitIn(h, batch, `${DB}/meta/0001_snapshot.json`, snapshot('s1', 'b'));
        await commitIn(h, batch, `${DB}/0001_mine.sql`, 'update a;\n');
        h.git$('push', '-q', 'origin', `${batch.branch ?? ''}:${batch.branch ?? ''}`);
        h.teammatePush('main', `${DB}/meta/_journal.json`, journal('0000_init', '0001_theirs'));
        h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\n# changed\n');
        conflicts(batch);
        h.state.write((c) => patchProject(c, h.project.id, { gateCommand: null }));
        return batch;
      }

      it(
        'pushes nothing when the install fails, the generators throw, the worktree is dirty or the install in the copy is broken',
        async () => {
          const rows: [string, string, (batch: BatchDto) => () => void][] = [
            [
              'the install the merged lockfile needs fails',
              'the install the merged lockfile needs failed',
              () => {
                vi.spyOn(h.ctx.dependencies, 'refresh').mockRejectedValue(
                  new Error('the install failed'),
                );
                return () => undefined;
              },
            ],
            [
              'the generators throw',
              'no sandbox',
              () => {
                vi.spyOn(h.ctx.generators, 'regenerate').mockRejectedValue(new Error('no sandbox'));
                return () => undefined;
              },
            ],
            [
              'the worktree is dirty, so the generators never start',
              'uncommitted changes',
              (batch) => {
                const regenerate = vi.spyOn(h.ctx.generators, 'regenerate');
                writeFileSync(join(batch.worktreePath ?? '', 'src/index.ts'), 'in progress\n');
                return () => {
                  expect.soft(regenerate, 'the worktree is dirty').not.toHaveBeenCalled();
                };
              },
            ],
            [
              'the install in the copy is broken',
              'install',
              (batch) => {
                // The merged lockfile names a package no install brings.
                h.teammatePush(
                  'main',
                  'pnpm-lock.yaml',
                  "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n",
                );
                mkdirSync(join(batch.worktreePath ?? '', 'node_modules'), { recursive: true });
                return () => undefined;
              },
            ],
          ];
          for (const [i, [name, why, setUp]] of rows.entries()) {
            if (i > 0) reboot();
            const batch = await bothAdded();
            const checkRun = setUp(batch);
            const pushed = tipOnOrigin(batch.branch);

            await catchUp(batch);

            expect.soft(tipOnOrigin(batch.branch), name).toBe(pushed);
            expect.soft(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`), name).toBe(pushed);
            // The fixture keeps the worktree, which has a card of its own.
            const card = h.only(h.cards().filter((c) => !c.title.includes('kept the worktree')));
            expect.soft(card.title, name).toContain("couldn't update it");
            expect.soft(card.body, name).toContain('0001_mine');
            expect.soft(card.body, name).toContain(why);
            checkRun();
          }
        },
        ROWS_TIMEOUT,
      );
    });

    describe('the notice of migrations it renumbered', () => {
      const journal = (...tags: string[]): string =>
        `${JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) })}\n`;
      const snapshot = (id: string, ...tables: string[]): string =>
        `${JSON.stringify({ id, prevId: 'p', tables })}\n`;

      const SCHEMAS = 'packages/contracts/generated';

      /**
       * Main holds 0000_init and 0001_theirs; the shipped batch's 0001_mine collides with it. With
       * `otherDirectory` both also changed a generated directory, which the generators write again
       * unless `leftAsIs`: a problem that loses no migration, and stops the catch-up.
       */
      async function renumbering(
        gate: string | null,
        { otherDirectory = false, leftAsIs = false } = {},
      ): Promise<BatchDto> {
        h.commit(
          'packages/db/package.json',
          `${JSON.stringify({ name: '@10db/db', scripts: { generate: 'drizzle-kit generate' } })}\n`,
        );
        h.commit(`${DB}/meta/_journal.json`, journal('0000_init'));
        h.commit(`${DB}/meta/0000_snapshot.json`, snapshot('s0', 'a'));
        h.commit(`${DB}/0000_init.sql`, 'create table a;\n');
        if (otherDirectory) {
          h.commit(
            'packages/contracts/package.json',
            `${JSON.stringify({ name: '@10db/contracts', scripts: { generate: 'tsx generate.ts' } })}\n`,
          );
          h.commit(`${SCHEMAS}/a.schema.json`, '{"v":0}\n');
        }
        h.git$('push', '-q', 'origin', 'main');
        const batch = await shippedWith(
          `${DB}/meta/_journal.json`,
          journal('0000_init', '0001_mine'),
          {
            keepWorktree: true,
          },
        );
        await commitIn(h, batch, `${DB}/meta/0001_snapshot.json`, snapshot('s1', 'a', 'b'));
        await commitIn(h, batch, `${DB}/0001_mine.sql`, 'alter table a add b;\n');
        if (otherDirectory) {
          await commitIn(h, batch, `${SCHEMAS}/a.schema.json`, '{"v":"mine"}\n');
          h.teammatePush('main', `${SCHEMAS}/a.schema.json`, '{"v":"theirs"}\n');
        }
        h.git$('push', '-q', 'origin', `${batch.branch ?? ''}:${batch.branch ?? ''}`);
        h.teammatePush('main', `${DB}/0001_theirs.sql`, 'alter table a add c;\n');
        h.teammatePush('main', `${DB}/meta/0001_snapshot.json`, snapshot('theirs', 'a', 'c'));
        h.teammatePush('main', `${DB}/meta/_journal.json`, journal('0000_init', '0001_theirs'));
        conflicts(batch);
        h.state.write((c) => patchProject(c, h.project.id, { gateCommand: gate }));
        // What the package's generate does: the next free number after main's.
        vi.spyOn(h.ctx.generators, 'regenerate').mockImplementation(({ path, migrations = [] }) => {
          const file = join(path, DB, 'meta/_journal.json');
          const tags = (
            JSON.parse(readFileSync(file, 'utf8')) as { entries: { tag: string }[] }
          ).entries.map((e) => e.tag);
          for (const { name } of migrations) {
            const number = String(tags.length).padStart(4, '0');
            tags.push(`${number}_${name}`);
            writeFileSync(join(path, DB, `${number}_${name}.sql`), 'alter table a add b;\n');
            writeFileSync(
              join(path, DB, `meta/${number}_snapshot.json`),
              snapshot('mine', 'a', 'b', 'c'),
            );
          }
          writeFileSync(file, journal(...tags));
          if (otherDirectory && !leftAsIs)
            writeFileSync(join(path, SCHEMAS, 'a.schema.json'), '{"v":"regenerated"}\n');
          return Promise.resolve({ kind: 'done', logPath: join(path, 'generate.log') });
        });
        return batch;
      }

      const renumbered = (batch: BatchDto): readonly unknown[] =>
        getBatch(h.store.db, batch.id).notices.filter(
          (n) => n.key === NOTICE_KEY.migrationsRenumbered,
        );

      it('is left as it was when the check fails and the merge is put back, and lists the migration once when a catch-up starts over from the same branch', async () => {
        const batch = await renumbering('false');
        await catchUp(batch);
        expect(h.cards().some((c) => c.title.includes('gate failed'))).toBe(true);
        expect(renumbered(batch)).toEqual([]);
        // The catch-up waits out its retry time before it tries the same head again.
        h.shipClock.advance(31 * 60_000);
        await catchUp(getBatch(h.store.db, batch.id));
        expect(renumbered(batch)).toEqual([]);

        h.shipClock.advance(31 * 60_000);
        h.state.write((c) => patchProject(c, h.project.id, { gateCommand: null }));
        const now = await catchUp(getBatch(h.store.db, batch.id));

        const notice = h.only(now.notices.filter((n) => n.key === NOTICE_KEY.migrationsRenumbered));
        expect(notice.line).toContain('1 of this batch');
        expect(notice.body).toContain('0001_mine → 0002_mine');
      });

      it('is left as it was when a merge that regenerated another generated directory fails its check, then lists what was pushed', async () => {
        const batch = await renumbering('false', { otherDirectory: true });

        await catchUp(batch);

        expect(h.cards().some((c) => c.title.includes('gate failed'))).toBe(true);
        expect(renumbered(batch)).toEqual([]);

        // The check is fixed and the retry time passes.
        h.state.write((c) => patchProject(c, h.project.id, { gateCommand: null }));
        h.shipClock.advance(31 * 60_000);
        const now = await catchUp(getBatch(h.store.db, batch.id));

        expect(h.origin$('ls-tree', '--name-only', batch.branch ?? '', `${DB}/`)).toContain(
          '0002_mine.sql',
        );
        const notice = h.only(now.notices.filter((n) => n.key === NOTICE_KEY.migrationsRenumbered));
        expect(notice.body).toContain('0001_mine → 0002_mine');
      });

      it(
        'lists nothing and pushes nothing when another generated directory came back unchanged, with no check or a gate',
        async () => {
          const rows = [
            ['no check is set', null],
            ['a gate is set', 'true'],
          ] as const;
          for (const [i, [name, gate]] of rows.entries()) {
            if (i > 0) reboot();
            const batch = await renumbering(gate, { otherDirectory: true, leftAsIs: true });
            const pushed = tipOnOrigin(batch.branch);

            await catchUp(batch);

            expect.soft(tipOnOrigin(batch.branch), name).toBe(pushed);
            expect.soft(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`), name).toBe(pushed);
            // (The kept worktree has its own card, from the ship.)
            const card = h.only(h.cards().filter((c) => !c.title.includes('kept the worktree')));
            expect.soft(card.title, name).toContain("couldn't update it");
            expect.soft(card.body, name).toContain(`${SCHEMAS}/`);
            expect.soft(card.body, name).toContain('regenerating changed nothing');
            expect.soft(renumbered(batch), name).toEqual([]);
          }
        },
        ROWS_TIMEOUT,
      );
    });
  });

  it("keeps a builder's commit made in the kept worktree while the check runs, when it then fails", async () => {
    const batch = await shippedWith('src/index.ts', BOTH.mine, { keepWorktree: true });
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
    const batch = await shippedWith();
    expect(batch.notices.map((n) => n.key)).toEqual(['pull-request-merge']);
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const url = conflicts(batch);

    await catchUp(batch);
    // GitHub works out the new head and calls it clean.
    h.gh.setHead(url, tipOnOrigin(batch.branch));
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

  it('raises one card naming the files when 10db cannot settle the conflict and pushes nothing, then merges it after a restart once the builder settles it, when GitHub had refused the merge', async () => {
    h.gh.noRequiredChecks = true;
    h.gh.failNext.set(
      'prMerge',
      new GhError(
        'failed',
        'gh pr merge failed (exit 1): the merge commit cannot be cleanly created',
      ),
    );
    const batch = await shippedWith('README.md', '# ours\n');
    h.teammatePush('main', 'README.md', '# theirs\n');
    const before = tipOnOrigin(batch.branch);
    const url = conflicts(batch);

    const stopped = await catchUp(batch);

    expect(tipOnOrigin(batch.branch)).toBe(before);
    const card = h.only(h.cards());
    expect(card.title).toContain('conflicts with main');
    expect(card.body).toContain("10db couldn't settle them itself");
    expect(card.body).toContain('README.md');
    expect(card.body).toContain('Update branch');
    // The card is the one thing said: neither of the two notices stands.
    expect(stopped.notices).toEqual([]);
    expect(stopped.worktreePath).toBeNull();

    // Asked again for the same pull request head, it does not start over or raise another.
    await catchUp(stopped);
    expect(h.cards()).toHaveLength(1);
    expect(
      h.logs.lines().filter((l) => l['msg'] === 'base not merged before the gate'),
    ).toHaveLength(1);

    // The daemon restarts; the builder resolves the conflict on GitHub, as the card says.
    h.restartShipper();
    h.gh.setMergeBlocked(url, null);
    h.gh.setMergeable(url, PrMergeable.Mergeable);
    // The watch withdraws the open card in the round that reads the pull request clean, and says so.
    h.shipper.retryMerge(batch.id, { catchUpCardWasOpen: true });
    await h.jobs.idle();

    expect(h.gh.merged).toEqual([url]);
  });

  it("names only the builder's commit, and 10db's own unpushed merge as 10db's, in the kept worktree", async () => {
    const batch = await shippedWith('src/index.ts', BOTH.mine, { keepWorktree: true });
    const kept = batch.worktreePath ?? '';
    const branch = batch.branch ?? '';
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
    // A round's merge of main fails its check and can't be put back: it stays in the kept worktree, unpushed.
    vi.spyOn(h.git, 'rewindBranch').mockRejectedValueOnce(new Error('index.lock exists'));
    await catchUp(batch);
    const merge = h.git$('rev-parse', `refs/heads/${branch}`);
    expect(merge).not.toBe(tipOnOrigin(branch));
    expect(h.git$('log', '-1', '--format=%P', merge).split(' ')).toHaveLength(2);

    // The builder commits on top of that merge in the kept worktree.
    await commitIn(h, getBatch(h.store.db, batch.id), 'src/mine.ts');
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
    const head = tipOnOrigin(branch);
    expect(card.body).toContain(
      `git rebase --onto ${head.slice(0, 7)} ${merge.slice(0, 7)} ${branch}`,
    );
    expect(card.body).not.toContain('Push it to the pull request');
    expect(kept).not.toBe('');
  });

  it('raises one card when a checkout 10db did not make holds the branch', async () => {
    const batch = await shippedWith();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = tipOnOrigin(batch.branch);
    conflicts(batch);
    const byHand = mkdtempSync(join(tmpdir(), 'by-hand-'));
    try {
      h.git$('worktree', 'add', '-q', join(byHand, 'wt'), batch.branch ?? '');

      const now = await catchUp(batch);

      expect(tipOnOrigin(batch.branch)).toBe(before);
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

  it('says on its tasks that it conflicts while a running CI fix holds the branch, and raises its card once that batch has failed', async () => {
    const batch = await shippedWith();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = tipOnOrigin(batch.branch);
    conflicts(batch);
    const byHand = mkdtempSync(join(tmpdir(), 'by-hand-'));
    try {
      // A second batch whose worktree, made by hand, holds the shipped batch's branch.
      const where = join(byHand, 'wt');
      h.git$('worktree', 'add', '-q', where, batch.branch ?? '');
      const fix = h.starter.startTask(h.addTask('Beta').id);
      const open = { state: 'OPEN', ciFixOf: batch.id } as const;
      h.state.write((w) => patchBatch(w, fix.id, { ...open, worktreePath: where }));

      const waiting = await catchUp(batch);

      expect(tipOnOrigin(batch.branch)).toBe(before);
      expect(waiting.notices.map((n) => n.key)).toEqual(['base-conflict']);
      expect(waiting.notices[0]?.line).toContain('conflicts with main');
      expect(h.cards().filter((c) => c.title.includes('conflicts with main'))).toEqual([]);

      // The fix fails and keeps its worktree: asked again, the catch-up raises its card.
      const failed = { state: 'FAILED' } as const;
      h.state.write((w) => patchBatch(w, fix.id, { ...failed, worktreePath: where }));
      const now = await catchUp(getBatch(h.store.db, batch.id));

      expect(tipOnOrigin(batch.branch)).toBe(before);
      const card = h.only(h.cards().filter((c) => c.title.includes('conflicts with main')));
      expect(card.body).toContain(`${batch.branch ?? ''} is checked out at`);
      expect(now.notices).toEqual([]);
    } finally {
      rmSync(byHand, { recursive: true, force: true });
    }
  });

  it('is left to the builder, conflicting or with checks that never started, when the batch did not ask to be merged by itself', async () => {
    reboot({ landing: 'hold' });
    const batch = await shippedWith();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    const before = tipOnOrigin(batch.branch);
    const url = conflicts(batch);
    await catchUp(batch);
    expect(tipOnOrigin(batch.branch)).toBe(before);
    expect(h.cards()).toEqual([]);

    h.gh.setBlockedOnChecks(url, true);
    h.shipper.restartCi(batch.id);
    await h.jobs.idle();
    expect(tipOnOrigin(batch.branch)).toBe(before);
  });
});

describe('a catch-up while a waiting update drains the factory', () => {
  /** A shipped pull request that conflicts with main, as the drain begins. */
  async function conflictingAsItDrains() {
    const batch = await shippedWith();
    h.teammatePush('main', 'src/index.ts', BOTH.theirs);
    conflicts(batch);
    draining = true;
    return { batch, before: tipOnOrigin(batch.branch) };
  }

  it('starts no gate to bring the base into a conflicting pull request or one whose checks never started, and brings it in when the next round asks once the drain has ended', async () => {
    const { batch, before } = await conflictingAsItDrains();

    h.shipper.catchUp(batch.id);
    expect(h.jobs.pending()).toBe(0);
    await h.jobs.idle();
    expect(tipOnOrigin(batch.branch)).toBe(before);

    // Held: it says so, and the watch keeps the ask unasked.
    expect(h.shipper.restartCi(batch.id)).toBe(false);
    expect(h.jobs.pending()).toBe(0);
    await h.jobs.idle();
    expect(tipOnOrigin(batch.branch)).toBe(before);

    draining = false;
    await catchUp(batch);
    expect(tipOnOrigin(batch.branch)).not.toBe(before);
  });
});

describe('a shipped pull request whose head never got its required checks', () => {
  /** GitHub holds the pull request, which merges cleanly, for a required check that has no run. */
  function waitsForChecks(batch: BatchDto): string {
    const url = batch.prUrl ?? '';
    h.gh.setHead(url, tipOnOrigin(batch.branch));
    h.gh.setBlockedOnChecks(url, true);
    return url;
  }

  async function restartCi(batch: BatchDto): Promise<BatchDto> {
    h.shipper.restartCi(batch.id);
    await h.jobs.idle();
    return getBatch(h.store.db, batch.id);
  }

  it('pushes nothing while the branch holds the base, a check has run, GitHub is not blocked on checks, it is in the merge queue or the gate fails, then has the base merged in and pushed so a new head gets its workflows', async () => {
    const batch = await shippedWith();
    const branch = batch.branch ?? '';
    const url = waitsForChecks(batch);

    // The branch already holds the base: nothing to push, and no card.
    const before = tipOnOrigin(branch);
    let now = await restartCi(batch);
    expect(tipOnOrigin(branch)).toBe(before);
    expect(h.cards()).toEqual([]);
    expect(now.notices).toEqual([]);

    const teammate = h.teammatePush('main', 'src/other.ts', 'export {};\n');
    expect(tipOnOrigin(branch)).toBe(before);

    // A check that has appeared since, running or finished, is never pushed over.
    for (const [name, conclusion] of [
      ['running', null],
      ['passed', 'SUCCESS'],
      ['failed', 'FAILURE'],
    ] as const) {
      h.gh.setChecks(url, [
        {
          __typename: 'CheckRun' as const,
          name: 'build',
          status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
          conclusion,
          detailsUrl: null,
        },
      ]);
      now = await restartCi(batch);
      expect.soft(tipOnOrigin(branch), `checks ${name}`).toBe(before);
      expect.soft(now.notices, `checks ${name}`).toEqual([]);
    }
    h.gh.setChecks(url, []);

    // GitHub is not blocked on checks, such as a base with no CI.
    h.gh.setBlockedOnChecks(url, false);
    await restartCi(batch);
    expect(tipOnOrigin(branch)).toBe(before);
    h.gh.setBlockedOnChecks(url, true);

    // In the merge queue, which reads BLOCKED with no checks.
    h.gh.setInMergeQueue(url, true);
    now = await restartCi(batch);
    expect(tipOnOrigin(branch)).toBe(before);
    expect(now.notices).toEqual([]);
    expect(h.cards()).toEqual([]);
    h.gh.setInMergeQueue(url, false);

    // The gate runs on the merged branch: on a failure it pushes nothing and raises no card.
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: 'false' }));
    now = await restartCi(batch);
    expect(tipOnOrigin(branch)).toBe(before);
    // The watch's notice says the checks never started; a card about conflicts would be wrong.
    expect(h.cards()).toEqual([]);
    expect(now.notices).toEqual([]);
    expect(h.git$('rev-parse', `refs/heads/${branch}`)).toBe(before);

    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: h.project.gateCommand }));
    now = await restartCi(batch);

    const tip = tipOnOrigin(branch);
    expect(tip).not.toBe(before);
    expect(h.origin$('log', '-1', '--format=%P', tip)).toBe(`${before} ${teammate}`);
    expect(h.cards()).toEqual([]);
    const notice = h.only(now.notices);
    expect(notice).toMatchObject({ key: 'pull-request-update', tone: 'info' });
    expect(notice.line).toBe('10db merged main into the pull request to start its checks');
    expect(now.worktreePath).toBeNull();
  });
});

describe('a shipped pull request that failed the checks its base failed too', () => {
  it('has the base merged in and pushed once, so its checks run on a head that holds the base', async () => {
    const batch = await shippedWith();
    const branch = batch.branch ?? '';
    const url = batch.prUrl ?? '';
    h.gh.setHead(url, tipOnOrigin(branch));
    h.gh.setChecks(url, [
      {
        __typename: 'CheckRun' as const,
        name: 'e2e',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: null,
      },
    ]);
    const before = tipOnOrigin(branch);
    const teammate = h.teammatePush('main', 'src/other.ts', 'export {};\n');

    // The never-started restart leaves a head that has checks alone.
    h.shipper.restartCi(batch.id);
    await h.jobs.idle();
    expect(tipOnOrigin(branch)).toBe(before);

    expect(h.shipper.catchUpToBase(batch.id)).toBe(true);
    await h.jobs.idle();
    const tip = tipOnOrigin(branch);
    expect(tip).not.toBe(before);
    expect(h.origin$('log', '-1', '--format=%P', tip)).toBe(`${before} ${teammate}`);
    expect(h.cards()).toEqual([]);
    expect(h.only(getBatch(h.store.db, batch.id).notices)).toMatchObject({
      key: 'pull-request-update',
    });
  });
});

describe('a merge GitHub refused for a reason that has gone', () => {
  it('is retried, not again at once when GitHub refuses it again, and merged on the retry after that', async () => {
    h.gh.noRequiredChecks = true;
    const refusal = () => new GhError('failed', 'gh pr merge failed (exit 1): not mergeable');
    h.gh.failNext.set('prMerge', refusal());
    const batch = await shippedWith();
    expect(h.gh.merged).toEqual([]);
    expect(batch.notices.map((n) => n.key)).toEqual(['pull-request-merge']);

    h.gh.failNext.set('prMerge', refusal());
    h.shipper.retryMerge(batch.id);
    await h.jobs.idle();
    h.shipper.retryMerge(batch.id);
    await h.jobs.idle();
    expect(h.gh.calls.filter((c) => c.method === 'prMerge')).toHaveLength(2);
    expect(h.gh.merged).toEqual([]);

    // The retry time passes: the reason has gone, and the next retry merges it.
    h.shipClock.advance(11 * 60_000);
    h.shipper.retryMerge(batch.id);
    await h.jobs.idle();

    expect(h.gh.merged).toEqual([batch.prUrl]);
    expect(getBatch(h.store.db, batch.id).notices).toEqual([]);
  });
});
