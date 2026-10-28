import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ConflictError, type BatchDto, type TaskDto } from '@10db/contracts';
import {
  findBatchByWorktreePath,
  getBatch,
  insertBatch,
  insertWorkstream,
  listBatches,
  listWorkstreams,
  patchProject,
  seedProject,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv } from '../../test/fixtures';
import { hangingSsh } from '../../test/hanging-ssh';
import { parseWorktreeList, type WorktreeEntry } from '../git';
import { batchBranchName } from './index';

let h: DeliveryHarness;
beforeEach(() => {
  // These tests move batches by hand; the ship trigger would race them.
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
});
afterEach(() => {
  h.close();
});

/** Every worktree git lists for the main checkout, the main checkout first. */
function worktrees(): WorktreeEntry[] {
  return parseWorktreeList(
    execFileSync('git', ['-C', h.repo, 'worktree', 'list', '--porcelain', '-z'], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    }).toString(),
  );
}

/** The worktrees 10db locked as a batch's. */
function locked(): WorktreeEntry[] {
  return worktrees().filter((e) => e.locked?.startsWith('10db bat_') === true);
}

/** git in a batch's worktree. */
function gitIn(path: string, ...args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
}

function branches10db(): string[] {
  return h
    .git$('for-each-ref', '--format=%(refname)', 'refs/heads/10db/')
    .split('\n')
    .filter(Boolean);
}

function pathOf(batch: BatchDto): string {
  if (batch.worktreePath === null) throw new Error(`batch ${batch.title} has no worktree path`);
  return batch.worktreePath;
}

/** Starts one task, waits for its cut and returns its batch as it is now. */
async function startedOne(task: TaskDto): Promise<BatchDto> {
  const batch = h.starter.startTask(task.id);
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

/** Commits `path` in the main checkout and pushes main to origin, as the builder would. */
function pushed(path: string, content: string): void {
  h.commit(path, content);
  h.git$('push', '-q', 'origin', 'main');
}

describe('starting in worktree mode', () => {
  it('three task starts make three CUTTING batches with their workstreams queued, then three worktrees and branches', async () => {
    const tasks = ['Alpha', 'Beta', 'Gamma'].map((title) => h.addTask(title));
    const started = tasks.map((task) => h.starter.startTask(task.id));
    expect(started.map((b) => b.state)).toEqual(['CUTTING', 'CUTTING', 'CUTTING']);
    expect(started.map((b) => b.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
    for (const [i, batch] of started.entries())
      expect(
        listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => [w.taskId, w.state]),
      ).toEqual([[tasks[i]?.id, 'QUEUED']]);
    await h.jobs.idle();

    expect(statSync(h.worktreeRoot).mode & 0o777).toBe(0o700);
    const origin = h.git$('rev-parse', 'refs/remotes/origin/main');
    const batches = started.map((b) => getBatch(h.store.db, b.id));
    expect(batches.map((b) => b.state)).toEqual(['OPEN', 'OPEN', 'OPEN']);
    expect(
      locked()
        .map((e) => e.locked)
        .sort(),
    ).toEqual(batches.map((b) => `10db ${b.id}`).sort());
    for (const batch of batches) {
      const path = pathOf(batch);
      expect(batch).toMatchObject({
        branch: batchBranchName(batch.title, batch.id),
        baseSha: origin,
        repo: 'acme/widgets',
      });
      // The stored path is the real one git made, so the pin store finds the batch by it.
      expect(path.startsWith(`${h.worktreeRoot}/`)).toBe(true);
      expect(realpathSync(path)).toBe(path);
      const entry = locked().find((e) => e.locked === `10db ${batch.id}`);
      expect(entry && realpathSync(entry.path)).toBe(path);
      expect(findBatchByWorktreePath(h.store.db, path)?.id).toBe(batch.id);
      expect(gitIn(path, 'branch', '--show-current')).toBe(batch.branch);
      expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# fixture\n');
      expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.state)).toEqual([
        'QUEUED',
      ]);
    }
    expect(branches10db().sort()).toEqual(
      batches.map((b) => `refs/heads/${b.branch ?? ''}`).sort(),
    );
    expect(h.ticks.count).toBe(3);
    expect(h.cards()).toEqual([]);
  });

  it('a second start of a task whose cut is in flight is refused as already running', async () => {
    const alpha = h.addTask('Alpha');
    h.starter.startTask(alpha.id);
    expect(() => h.starter.startTask(alpha.id)).toThrow(ConflictError);
    expect(() => h.starter.startTask(alpha.id)).toThrow(/already running/);
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toHaveLength(1);
  });

  it("a set with a chain and an independent task makes two batches, titled after the chain's first task", async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'], dependsOn: [alpha.id] });
    const gamma = h.addTask('Gamma');
    const started = h.starter.startBatch(h.project.id, {
      title: 'Beta',
      taskIds: [beta.id, alpha.id, gamma.id],
    });
    expect(started.map((b) => [b.title, b.state])).toEqual([
      ['Alpha', 'CUTTING'],
      ['Gamma', 'CUTTING'],
    ]);
    await h.jobs.idle();
    const [chain, single] = started.map((b) => getBatch(h.store.db, b.id));
    if (!chain || !single) throw new Error('two batches expected');
    expect(listWorkstreams(h.store.db, { batchId: chain.id }).map((w) => w.taskId)).toEqual([
      beta.id,
      alpha.id,
    ]);
    expect(listWorkstreams(h.store.db, { batchId: single.id }).map((w) => w.taskId)).toEqual([
      gamma.id,
    ]);
    expect([chain.state, single.state]).toEqual(['OPEN', 'OPEN']);
    expect(chain.branch).toBe(batchBranchName('Alpha', chain.id));
    expect(locked()).toHaveLength(2);
  });

  it('starts while another batch of the project is cutting or shipping', async () => {
    const first = h.starter.startTask(h.addTask('Alpha').id);
    expect(h.starter.startTask(h.addTask('Beta').id).state).toBe('CUTTING');
    await h.jobs.idle();
    h.state.write((c) => transitionBatch(c, first.id, { to: 'SHIPPING' }));
    const third = await startedOne(h.addTask('Gamma'));
    expect(third.state).toBe('OPEN');
    expect(listBatches(h.store.db).map((b) => b.state)).toEqual(['SHIPPING', 'OPEN', 'OPEN']);
  });

  it('leaves a dirty main checkout on another branch exactly as it was', async () => {
    h.git$('switch', '-q', '-c', 'mine');
    writeFileSync(join(h.repo, 'README.md'), '# edited, not committed\n');
    writeFileSync(join(h.repo, 'scratch.txt'), 'untracked\n');
    const snapshot = () => ({
      branch: h.git$('branch', '--show-current'),
      head: h.git$('rev-parse', 'HEAD'),
      index: h.git$('ls-files', '-s'),
      status: h.git$('status', '--porcelain'),
      readme: readFileSync(join(h.repo, 'README.md')),
      scratch: readFileSync(join(h.repo, 'scratch.txt')),
    });
    const before = snapshot();
    for (const title of ['Alpha', 'Beta', 'Gamma']) h.starter.startTask(h.addTask(title).id);
    await h.jobs.idle();
    expect(listBatches(h.store.db).map((b) => b.state)).toEqual(['OPEN', 'OPEN', 'OPEN']);
    expect(snapshot()).toEqual(before);
    expect(before.branch).toBe('mine');
  });

  it('seeds node_modules by clone and seeds nothing else', async () => {
    pushed('.gitignore', 'node_modules/\ndist/\n');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    mkdirSync(join(h.repo, 'dist'));
    writeFileSync(join(h.repo, 'dist', 'out.js'), 'built\n');
    const batch = await startedOne(h.addTask('Alpha'));
    const path = pathOf(batch);
    expect(batch.state).toBe('OPEN');
    expect(readFileSync(join(path, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe(
      'module.exports = 1;\n',
    );
    expect(existsSync(join(path, 'dist'))).toBe(false);
    expect(h.logs.lines()).toContainEqual(
      expect.objectContaining({ batchId: batch.id, files: 1, links: 0, skipped: [] }),
    );
  });
});

describe('refusing a worktree cut', () => {
  it.each<{
    name: string;
    /** Sets the case up and adds the task to start. */
    arrange: (x: DeliveryHarness) => Promise<TaskDto>;
    /** Runs after the request answered and before its job ran. */
    meanwhile?: (x: DeliveryHarness, batch: BatchDto) => void;
    title: string;
    /** Whether something is left at the worktree path: only what 10db didn't make. */
    kept?: boolean;
    restore?: (x: DeliveryHarness) => void;
  }>([
    {
      name: 'no origin',
      arrange: async (x) => {
        await x.git.head(x.repo);
        x.git$('remote', 'remove', 'origin');
        return x.addTask('Alpha');
      },
      title: 'has no remote named origin',
    },
    {
      name: 'origin is not GitHub',
      arrange: async (x) => {
        x.git$('remote', 'set-url', 'origin', 'https://gitlab.com/acme/widgets.git');
        await x.git.head(x.repo);
        return x.addTask('Alpha');
      },
      title: 'is not a github.com repository',
    },
    {
      name: 'the base branch is missing on origin',
      arrange: (x) => {
        x.state.write((c) => patchProject(c, x.project.id, { baseBranch: 'nope' }));
        return Promise.resolve(x.addTask('Alpha'));
      },
      title: 'git fetch origin nope failed',
    },
    {
      name: 'gh is signed out',
      arrange: (x) => {
        x.gh.auth = 'signed_out';
        return Promise.resolve(x.addTask('Alpha'));
      },
      title: 'gh is signed out',
    },
    {
      name: 'gh is not installed',
      arrange: (x) => {
        x.gh.auth = 'not_installed';
        return Promise.resolve(x.addTask('Alpha'));
      },
      title: 'gh is not installed',
    },
    {
      name: 'a dependency is not merged',
      arrange: (x) => {
        // Done in a batch that shipped with its pull request still open; made in the database only,
        // so the git state the row checks holds nothing of it.
        const dep = x.addTask('Dep', { areas: ['ui'] });
        const shipped = x.state.write((c) => {
          const b = insertBatch(c, { projectId: x.project.id, title: 'Dep', baseBranch: 'main' });
          return transitionBatch(c, b.id, {
            to: 'OPEN',
            patch: { branch: '10db/dep-0a1b2c3d', baseSha: 'a'.repeat(40), repo: 'acme/widgets' },
          });
        });
        const ws = x.state.write((c) => insertWorkstream(c, dep.id, { batchId: shipped.id }));
        x.settle(ws.id, 'DONE');
        const url = x.gh.openPr('10db/dep-0a1b2c3d');
        x.state.write((c) => {
          transitionBatch(c, shipped.id, { to: 'SHIPPING' });
          transitionBatch(c, shipped.id, { to: 'SHIPPED', patch: { prUrl: url } });
        });
        return Promise.resolve(x.addTask('Alpha', { dependsOn: [dep.id] }));
      },
      title: 'depend on code that is not on the base branch',
    },
    {
      name: 'the base tree uses filters',
      arrange: (x) => {
        x.commit('.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
        x.git$('push', '-q', 'origin', 'main');
        return Promise.resolve(x.addTask('Alpha'));
      },
      title: 'uses git filters',
    },
    {
      name: 'the worktree path exists',
      arrange: (x) => Promise.resolve(x.addTask('Alpha')),
      meanwhile: (_x, batch) => {
        mkdirSync(pathOf(batch), { recursive: true });
      },
      title: 'already exists',
      kept: true,
    },
    {
      name: "the seed can't be read",
      arrange: (x) => {
        x.commit('.gitignore', 'node_modules/\n');
        x.git$('push', '-q', 'origin', 'main');
        mkdirSync(join(x.repo, 'node_modules', 'locked'), { recursive: true });
        chmodSync(join(x.repo, 'node_modules', 'locked'), 0o000);
        return Promise.resolve(x.addTask('Alpha'));
      },
      title: "couldn't seed the worktree",
      restore: (x) => {
        chmodSync(join(x.repo, 'node_modules', 'locked'), 0o700);
      },
    },
  ])(
    'refuses when $name: a card, the row gone, the task startable, nothing made left',
    async ({ arrange, meanwhile, title, kept = false, restore }) => {
      const task = await arrange(h);
      try {
        const batch = h.only(
          h.starter.startBatch(h.project.id, { title: task.title, taskIds: [task.id] }),
        );
        const path = pathOf(batch);
        meanwhile?.(h, batch);
        await h.jobs.idle();
        expect(h.cards().map((c) => c.title)).toEqual([expect.stringContaining(title)]);
        expect(h.only(h.cards()).detail).toMatchObject({ taskIds: [task.id] });
        expect(listBatches(h.store.db).filter((b) => b.id === batch.id)).toEqual([]);
        const ws = h.only(listWorkstreams(h.store.db, {}).filter((w) => w.taskId === task.id));
        expect(ws).toMatchObject({ state: 'CANCELLED', batchId: null });
        expect(worktrees()).toHaveLength(1);
        expect(existsSync(path)).toBe(kept);
        expect(branches10db()).toEqual([]);
        expect(h.starter.startTask(task.id).state).toBe('CUTTING');
        await h.jobs.idle();
      } finally {
        restore?.(h);
      }
    },
  );

  it('a shutdown mid-cut leaves the CUTTING row for recovery', async () => {
    const ssh = hangingSsh(30);
    h.close();
    h = createDeliveryHarness(
      { workspaceMode: 'worktree' },
      { trigger: false, networkEnv: ssh.env },
    );
    // Before the daemon first sees the checkout, which records origin's URLs: the fetch goes over
    // ssh, whose ssh is the hanging stand-in.
    h.git$('remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git');
    try {
      const batch = h.starter.startTask(h.addTask('Alpha').id);
      await ssh.childPid();
      await h.jobs.stop();
      expect(getBatch(h.store.db, batch.id).state).toBe('CUTTING');
      expect(worktrees()).toHaveLength(1);
      expect(existsSync(pathOf(batch))).toBe(false);
      expect(branches10db()).toEqual([]);
      expect(h.cards()).toEqual([]);
    } finally {
      ssh.cleanup();
    }
  });
});

describe('fix tasks in worktree mode', () => {
  it('a fix task with batchId joins an OPEN worktree batch', async () => {
    const alpha = h.addTask('Alpha');
    const batch = await startedOne(alpha);
    const fix = h.addTask('Fix', { areas: ['ui'] });
    const answered = h.starter.startBatch(h.project.id, {
      title: 'Fix',
      taskIds: [fix.id],
      batchId: batch.id,
    });
    expect(answered.map((b) => b.id)).toEqual([batch.id]);
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).toEqual([
      alpha.id,
      fix.id,
    ]);
    expect(listBatches(h.store.db)).toHaveLength(1);
    expect(locked()).toHaveLength(1);
    expect(h.ticks.count).toBe(2);
    expect(h.cards()).toEqual([]);
  });

  it('adds nothing and raises a card when the worktree left the batch branch', async () => {
    const batch = await startedOne(h.addTask('Alpha'));
    gitIn(pathOf(batch), 'switch', '-q', '--detach');
    const fix = h.addTask('Fix', { areas: ['ui'] });
    h.starter.startBatch(h.project.id, { title: 'Fix', taskIds: [fix.id], batchId: batch.id });
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).not.toContain(
      fix.id,
    );
    const card = h.only(h.cards());
    expect(card.title).toContain(
      `checkout is on a detached HEAD, the batch branch is ${batch.branch ?? ''}`,
    );
    expect(card.body).toContain(pathOf(batch));
  });

  it('a fix task with batchId naming a FAILED worktree batch answers 409 until reopening exists', async () => {
    const batch = await startedOne(h.addTask('Alpha'));
    h.state.write((c) =>
      transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );
    const fix = h.addTask('Fix', { areas: ['ui'] });
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Fix', taskIds: [fix.id], batchId: batch.id }),
    ).toThrow(ConflictError);
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, {}).map((w) => w.taskId)).not.toContain(fix.id);
    expect(getBatch(h.store.db, batch.id).state).toBe('FAILED');
  });

  it("refuses a batchId of another project's batch", async () => {
    await startedOne(h.addTask('Alpha'));
    const elsewhere = seedProject(h.store, {
      repoPath: `${h.repo}-other`,
      delivery: 'pull_request',
      prTitlePrefix: 'fix',
    });
    const other = h.state.write((c) => {
      const b = insertBatch(c, { projectId: elsewhere.id, title: 'x', baseBranch: 'main' });
      return transitionBatch(c, b.id, { to: 'OPEN' });
    });
    const fix = h.addTask('Fix', { areas: ['ui'] });
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Fix', taskIds: [fix.id], batchId: other.id }),
    ).toThrow(ConflictError);
  });
});
