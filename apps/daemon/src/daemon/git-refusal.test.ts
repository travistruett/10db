import { realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxItemDto } from '@10db/contracts';
import { createTestStore, insertBatch, listInbox, listProjects, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRepo, isolatedGitEnv, tempDir, type TempDir } from '../../test/fixtures';
import { execFileSync } from 'node:child_process';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit, GitTrustError, memoryPinStore, type Git } from '../git';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import { createProjectPinStore } from './checkout-pins';
import {
  createCheckoutTrustedHandler,
  createGitCardAnswers,
  createGitRefusalHandler,
} from './git-refusal';

let close: () => void;
let state: StateStore;
let inbox: InboxService;
let handle: (error: GitTrustError) => void;
let repo: TempDir;
let real: string;

beforeEach(() => {
  repo = createTempRepo();
  real = realpathSync(repo.path);
  const test = createTestStore();
  close = test.close;
  // The project names the checkout through a path that is not its real one.
  seedProject(test.store, { repoPath: `${repo.path}/.` });
  state = createStateStore(test.store, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  handle = createGitRefusalHandler({ db: state.db, inbox, logger: silentLogger });
});
afterEach(() => {
  close();
  repo.cleanup();
});

/** A found checkout state, as a refusal records it. */
const candidate = (gitDir: string, id = '1:2/1:2') => ({
  gitDir,
  commonDir: gitDir,
  id,
  fetchUrl: null,
  pushUrl: null,
});

describe('a refusal of the daemon git', () => {
  it.each([
    {
      name: 'config keys',
      error: () =>
        new GitTrustError(real, {
          kind: 'config',
          keys: [{ key: 'core.sshcommand', file: `${real}/.git/config` }],
        }),
      title: () => `10db won't fetch or push in ${real}: its config sets core.sshcommand`,
      body: () => `git config --file '${real}/.git/config' --unset-all 'core.sshcommand'`,
      retrust: false,
    },
    {
      name: 'a replaced git dir',
      error: () =>
        new GitTrustError(real, {
          kind: 'moved',
          pinned: `${real}/.git`,
          found: '/elsewhere/.git',
          pin: candidate(`${real}/.git`),
          candidate: candidate('/elsewhere/.git'),
        }),
      title: () =>
        `10db won't run git in ${real}: its git dir is /elsewhere/.git, not ${real}/.git as 10db recorded`,
      body: () => 'Trust the checkout as it is now',
      retrust: true,
    },
    {
      name: 'a git dir replaced at the same path',
      error: () =>
        new GitTrustError(real, {
          kind: 'moved',
          pinned: `${real}/.git`,
          found: `${real}/.git`,
          pin: candidate(`${real}/.git`, '9:100/9:100'),
          candidate: candidate(`${real}/.git`, '9:200/9:200'),
        }),
      title: () =>
        `10db won't run git in ${real}: ${real}/.git is at the same path but is a different repository now (inode 200, was 100)`,
      body: () => 'Trust the checkout as it is now',
      retrust: true,
    },
    {
      name: 'a worktree whose common dir was replaced at the same path, its own git dir kept',
      error: () =>
        new GitTrustError(real, {
          kind: 'moved',
          pinned: `${real}/.git/worktrees/wt`,
          found: `${real}/.git/worktrees/wt`,
          pin: {
            ...candidate(`${real}/.git/worktrees/wt`, '9:300/9:100'),
            commonDir: `${real}/.git`,
          },
          candidate: {
            ...candidate(`${real}/.git/worktrees/wt`, '9:300/9:200'),
            commonDir: `${real}/.git`,
          },
        }),
      title: () =>
        `10db won't run git in ${real}: its common git dir ${real}/.git is at the same path but is a different repository now (inode 200, was 100)`,
      body: () => 'Trust the checkout as it is now',
      retrust: true,
    },
    {
      name: 'a moved HEAD before the commit',
      error: () =>
        new GitTrustError(real, {
          kind: 'branch',
          expected: 'lane',
          found: 'main',
          committed: false,
        }),
      title: () =>
        `10db won't commit in ${real}: the checkout is on main, the lane's branch is lane`,
      body: () => `Switch back to \`lane\` in '${real}'`,
      retrust: false,
    },
    {
      name: 'a moved HEAD while the commit ran',
      error: () =>
        new GitTrustError(real, {
          kind: 'branch',
          expected: 'lane',
          found: 'main',
          committed: true,
        }),
      title: () => `10db committed on lane in ${real}, but HEAD moved to main while it ran`,
      body: () => 'The commit is on `lane`, where it belongs',
      retrust: false,
    },
    {
      name: 'a changed origin',
      error: () =>
        new GitTrustError(real, {
          kind: 'origin',
          direction: 'push',
          pinned: 'git@github.com:acme/widgets.git',
          found: 'git@evil.invalid:x.git',
          candidate: candidate(`${real}/.git`),
        }),
      title: () =>
        `10db won't push in ${real}: origin's push URL is git@evil.invalid:x.git, not git@github.com:acme/widgets.git as 10db recorded`,
      body: () => 'never one read from config a lane could have written',
      retrust: true,
    },
    {
      name: 'a filter',
      error: () =>
        new GitTrustError(real, { kind: 'filter', paths: [{ path: 'a.bin', filter: 'lfs' }] }),
      title: () => `10db won't commit or push in ${real}: a.bin needs the lfs filter`,
      body: () => "A repository that uses Git LFS can't ship through 10db yet",
      retrust: false,
    },
  ])('raises one card on the project for $name', ({ error, title, body, retrust }) => {
    handle(error());
    handle(error());
    const cards = listInbox(state.db);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe(title());
    expect(cards[0]?.body).toContain(body());
    expect(cards[0]?.options.map((o) => o.label) ?? []).toEqual(
      retrust ? ['Trust the checkout as it is now', 'Later'] : [],
    );
  });

  it('keeps one card per checkout and cause, however many keys a lane writes', () => {
    for (let i = 0; i < 20; i += 1)
      handle(
        new GitTrustError(real, {
          kind: 'config',
          keys: [{ key: `alias.a${String(i)}`, file: `${real}/.git/config` }],
        }),
      );
    expect(listInbox(state.db)).toHaveLength(1);
  });

  it('opens a new card for a second move rather than folding it into the first', () => {
    for (const id of ['1:2/1:2', '3:4/3:4'])
      handle(
        new GitTrustError(real, {
          kind: 'moved',
          pinned: `${real}/.git`,
          found: `${real}/.git`,
          pin: candidate(`${real}/.git`, '0:0/0:0'),
          candidate: candidate(`${real}/.git`, id),
        }),
      );
    expect(listInbox(state.db)).toHaveLength(2);
  });

  it('folds a move refused again after the volume gets a new device number into the open card', () => {
    for (const id of ['1:200/1:200', '7:200/7:200'])
      handle(
        new GitTrustError(real, {
          kind: 'moved',
          pinned: `${real}/.git`,
          found: `${real}/.git`,
          pin: candidate(`${real}/.git`, '1:100/1:100'),
          candidate: candidate(`${real}/.git`, id),
        }),
      );
    expect(listInbox(state.db)).toHaveLength(1);
  });

  it('closes the checkout’s re-trust cards by itself, saying why, once the checkout is trusted again', () => {
    const moved = (id: string) =>
      new GitTrustError(real, {
        kind: 'moved',
        pinned: `${real}/.git`,
        found: `${real}/.git`,
        pin: candidate(`${real}/.git`, '0:0/0:0'),
        candidate: candidate(`${real}/.git`, id),
      });
    // Two moves, and a cause trusting the checkout does not touch.
    handle(moved('1:2/1:2'));
    handle(moved('3:4/3:4'));
    handle(
      new GitTrustError(real, {
        kind: 'config',
        keys: [{ key: 'core.sshcommand', file: `${real}/.git/config` }],
      }),
    );
    const [project] = listProjects(state.db);
    if (!project) throw new Error('expected a project');
    // Another checkout's card.
    inbox.flag({
      projectId: project.id,
      workstreamId: null,
      title: 'Elsewhere',
      body: 'x',
      detail: { resolvesWhen: { event: 'checkout_trusted', repo: '/elsewhere' } },
    });
    expect(listInbox(state.db, { states: ['OPEN'] })).toHaveLength(4);

    createCheckoutTrustedHandler({ db: state.db, inbox })(real);

    const open = listInbox(state.db, { states: ['OPEN'] });
    expect(open.map((i) => i.title).sort()).toEqual(
      [`10db won't fetch or push in ${real}: its config sets core.sshcommand`, 'Elsewhere'].sort(),
    );
    const resolved = listInbox(state.db, { states: ['RESOLVED'] });
    expect(resolved).toHaveLength(2);
    for (const card of resolved)
      expect(card.detail).toMatchObject({
        resolution: { by: '10db', reason: `${real} is trusted again` },
      });
  });

  it('raises no card for a checkout no project uses', () => {
    handle(
      new GitTrustError('/elsewhere', {
        kind: 'moved',
        pinned: '/a',
        found: '/b',
        pin: candidate('/a'),
        candidate: candidate('/b'),
      }),
    );
    expect(listInbox(state.db)).toEqual([]);
  });
});

describe('a worktree under the worktree root with no pin', () => {
  it("raises the unpinned card on its batch's project and nothing else", async () => {
    const root = tempDir('worktrees');
    try {
      const path = join(root.path, 'wt');
      execFileSync('git', ['-C', repo.path, 'worktree', 'add', '-q', '-b', 'wt', path], {
        env: isolatedGitEnv(),
        stdio: 'pipe',
      });
      const [seeded] = listProjects(state.db);
      if (!seeded) throw new Error('expected a project');
      state.write((ctx) => {
        insertBatch(ctx, {
          projectId: seeded.id,
          title: 'wt',
          baseBranch: 'main',
          worktreePath: realpathSync(path),
        });
      });
      const git = createGit({
        worktreeRoot: root.path,
        onRefused: handle,
        pins: createProjectPinStore(state, memoryPinStore()),
      });
      await expect(git.currentBranch(path)).rejects.toMatchObject({
        detail: { kind: 'unpinned' },
      });
      expect(listInbox(state.db)).toEqual([
        expect.objectContaining({ projectId: seeded.id, kind: 'flag' }),
      ]);
    } finally {
      root.cleanup();
    }
  });
});

describe("the builder's answer to a re-trust card", () => {
  let git: Git;
  let scratch: TempDir;
  beforeEach(() => {
    scratch = tempDir('git-refusal');
    git = createGit({ onRefused: handle, pins: createProjectPinStore(state, memoryPinStore()) });
  });
  afterEach(() => {
    scratch.cleanup();
  });

  function replaceGitDir(): void {
    renameSync(join(repo.path, '.git'), join(scratch.path, `old-git-${String(Math.random())}`));
    execFileSync('git', ['-C', repo.path, 'init', '-q', '-b', 'main'], { env: isolatedGitEnv() });
  }
  const card = (): InboxItemDto => {
    const [only] = listInbox(state.db);
    if (!only) throw new Error('expected a card');
    return only;
  };

  it.each([
    { choice: 'Later', trusted: false },
    { choice: 'Trust the checkout as it is now', trusted: true },
  ])('$choice: re-trusted $trusted', async ({ choice, trusted }) => {
    await git.head(repo.path);
    replaceGitDir();
    await expect(git.currentBranch(repo.path)).rejects.toBeInstanceOf(GitTrustError);
    await createGitCardAnswers(git)(card(), { choice });
    if (trusted) expect(await git.currentBranch(repo.path)).toBe('main');
    else await expect(git.currentBranch(repo.path)).rejects.toBeInstanceOf(GitTrustError);
  });

  it('refuses again with a new card when the checkout changed after the card was raised', async () => {
    await git.head(repo.path);
    replaceGitDir();
    await expect(git.currentBranch(repo.path)).rejects.toBeInstanceOf(GitTrustError);
    const first = card();
    replaceGitDir();
    await createGitCardAnswers(git)(first, { choice: 'Trust the checkout as it is now' });
    await expect(git.currentBranch(repo.path)).rejects.toBeInstanceOf(GitTrustError);
    expect(listInbox(state.db)).toHaveLength(2);
  });

  it('keeps the pin in the database, so a restarted daemon still refuses', async () => {
    await git.head(repo.path);
    replaceGitDir();
    const restarted = createGit({ pins: createProjectPinStore(state, memoryPinStore()) });
    const onRefused = vi.fn();
    const watched = createGit({ onRefused, pins: createProjectPinStore(state, memoryPinStore()) });
    await expect(restarted.head(repo.path)).rejects.toBeInstanceOf(GitTrustError);
    await expect(watched.head(repo.path)).rejects.toBeInstanceOf(GitTrustError);
    expect(onRefused).toHaveBeenCalledOnce();
  });
});
