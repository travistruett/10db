import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import {
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  mintId,
  PassState,
  type ChatId,
  type ProjectDto,
  type SessionId,
} from '@10db/contracts';
import {
  createTestStore,
  insertChat,
  insertConversation,
  insertPass,
  insertTask,
  schema,
  seedProject,
  type Store,
} from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempClone,
  createTempRepoWithOrigin,
  githubOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  tempDir,
  type TempDir,
} from '../../test/fixtures';
import { FakeGh } from '../../test/fake-gh';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createFolderHold, type FolderHold } from '../folder-hold';
import { createGit } from '../git';
import { secretFilesIn } from '../sandbox';
import { createChatLiveSessions } from './live-sessions';
import { chatGitTools } from './git-tools';
import { takeHereForGitTool } from './work-takes-checkout';

// Sessions spec §7.3: the git tools run only while the turn holds Your folder, never on 10db's branches or
// while a closed pass waits, and the daemon's git does the work in a real repository.

let store: Store;
let closeStore: () => void;
let project: ProjectDto;
let hold: FolderHold;
let state: StateStore;
let pair: ReturnType<typeof createTempRepoWithOrigin>;
let repo: TempDir;
let network: ReturnType<typeof githubOrigin>;
let scratch: TempDir;
let gh: FakeGh;

beforeEach(() => {
  ({ store, close: closeStore } = createTestStore());
  const bus = createEventBus();
  state = createStateStore(store, bus);
  hold = createFolderHold({ state, bus });
  project = seedProject(store);
  pair = createTempRepoWithOrigin();
  repo = pair.repo;
  network = githubOrigin(repo.path, pair.origin.path);
  scratch = tempDir('chat-git-tools');
  gh = new FakeGh();
});
afterEach(() => {
  network.cleanup();
  scratch.cleanup();
  closeStore();
  pair.cleanup();
});

function newChat(title: string): { id: ChatId; conversationId: ReturnType<typeof conv> } {
  const id = mintId('Chat');
  const c = conv(id);
  store.write((ctx) => {
    insertChat(ctx, {
      id,
      projectId: project.id,
      conversationId: c,
      title,
      tabPosition: 0,
    });
  });
  return { id, conversationId: c };
}
function conv(chatId: ChatId) {
  return store.write(
    (ctx) =>
      insertConversation(ctx, {
        projectId: project.id,
        owner: { kind: ConversationOwnerKind.Chat, id: chatId },
        profile: ConversationProfile.Explore,
        state: ConversationState.IdleCold,
      }).id,
  ).value;
}

function closedPass(): void {
  store.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: 'Page',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    const opened = insertPass(ctx, {
      id: mintId('Pass'),
      projectId: project.id,
      name: 'Settings pass',
      pageCap: 4,
      returnBranch: 'main',
      startSha: 'a'.repeat(40),
      branch: '10db/pass-abc123',
      baseBranch: 'main',
      repo: null,
      taskIds: [task.id],
      dirt: [],
    });
    ctx.tx
      .update(schema.passes)
      .set({ state: PassState.Closed })
      .where(eq(schema.passes.id, opened.pass.id))
      .run();
  });
}

const rg = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

/** A chat's tools in a session of its own, open as the engine opens one. */
function tools(chat: ReturnType<typeof newChat>, open = true, afterCheck?: () => void) {
  const live = createChatLiveSessions();
  const sessionId: SessionId = mintId('Session');
  if (open)
    live.open(chat.conversationId, {
      sessionId,
      observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
      signal: new AbortController().signal,
    });
  const real = createGit();
  return chatGitTools(
    {
      // `afterCheck` runs once, right after the tool has read where the folder is: the moment a stop, a lane or
      // an archive can land between a tool's check and its write.
      git: {
        ...real,
        currentBranch: async (path) => {
          const branch = await real.currentBranch(path);
          const run = afterCheck;
          afterCheck = undefined;
          run?.();
          return branch;
        },
      },
      folderHold: hold,
      live,
      gh,
      filesDir: () => join(scratch.path, 'files'),
      repoOf: () => repo.path,
      secretFilesOf: secretFilesIn,
      net: () => ({
        env: { ...NETWORK_ENV, GIT_CONFIG_GLOBAL: network.global },
        timeoutMs: 20_000,
      }),
      takeHere: (chatId) => {
        takeHereForGitTool({ state, folderHold: hold }, chatId);
      },
    },
    { sessionId, conversationId: chat.conversationId, chatId: chat.id, projectId: project.id },
  );
}

function write(rel: string, text: string): void {
  const file = join(repo.path, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

type Tools = ReturnType<typeof tools>;
const CALLS: readonly [string, (t: Tools) => Promise<unknown>][] = [
  ['make_branch', (t) => t.make_branch({ name: 'topic' })],
  ['switch_branch', (t) => t.switch_branch({ name: 'main' })],
  ['pull', (t) => t.pull({})],
  ['commit_changes', (t) => t.commit_changes({ message: 'x' })],
];

describe("a chat's git tools", () => {
  it.each(CALLS)(
    '%s refuses while the turn does not hold Your folder, naming who does',
    async (_name, call) => {
      const me = newChat('Me');
      const reservation = hold.reserveGit(project.id, 'cutting a branch');
      expect(reservation.reserved).toBe(true);
      expect(hold.takeTurn(project.id, me.id).taken).toBe(false);
      await expect(call(tools(me))).rejects.toThrow(/10db cutting a branch/);
    },
  );

  it.each(CALLS)(
    '%s refuses while a closed pass waits for its pull request',
    async (_name, call) => {
      closedPass();
      const me = newChat('Me');
      expect(hold.takeTurn(project.id, me.id).taken).toBe(true);
      await expect(call(tools(me))).rejects.toThrow(/until its pull request merges/);
    },
  );

  it.each(CALLS)('%s refuses from a session that has ended', async (_name, call) => {
    const me = newChat('Me');
    hold.takeTurn(project.id, me.id);
    await expect(call(tools(me, false))).rejects.toThrow(/session has ended/);
  });

  it.each(CALLS)('%s refuses while Your folder is on a 10db branch', async (_name, call) => {
    rg('switch', '-q', '-c', '10db/batch-abc123');
    const me = newChat('Me');
    hold.takeTurn(project.id, me.id);
    await expect(call(tools(me))).rejects.toThrow(/10db's own/);
  });

  // Each name with the words its refusal carries, so a row that passes on git's own failure shows.
  const REFUSED_BRANCH_NAMES: [name: string, message: RegExp][] = [
    ['10db/x', /10db's own/],
    ['10DB/x', /10db's own/],
    ['-c', /never starts with - or \+/],
    ['+x', /never starts with - or \+/],
    ['@{-1}', /@\{/],
    ['topic@{-2}', /@\{/],
  ];

  it.each([
    ['make_branch', (t: Tools, name: string) => t.make_branch({ name })],
    ['switch_branch', (t: Tools, name: string) => t.switch_branch({ name })],
  ])('%s refuses 10db’s branches and names that read as options', async (_name, call) => {
    const me = newChat('Me');
    hold.takeTurn(project.id, me.id);
    const t = tools(me);
    // `@{-1}` would name the 10db branch the folder was on before.
    rg('switch', '-q', '-c', '10db/batch-abc123');
    rg('switch', '-q', 'main');
    for (const [name, message] of REFUSED_BRANCH_NAMES)
      await expect(call(t, name)).rejects.toThrow(message);
    expect(rg('branch', '--show-current')).toBe('main');
  });

  // The kernel denies the session the file but not git's objects, so a commit would hand it over.
  it.each([
    ['an env file no ignore rule covers', { secret: '.env.local', paths: undefined }],
    ['a file an env link points at', { secret: 'config/prod.txt', paths: ['config/prod.txt'] }],
  ])('commit_changes refuses %s and names it', async (_what, { secret, paths }) => {
    const me = newChat('Me');
    hold.takeTurn(project.id, me.id);
    write(secret, 'TOKEN=1\n');
    if (secret !== '.env.local') symlinkSync(secret, join(repo.path, '.env.link'));
    write('src/a.ts', 'a\n');
    const before = rg('rev-parse', 'HEAD');
    await expect(
      tools(me).commit_changes({ message: 'x', ...(paths === undefined ? {} : { paths }) }),
    ).rejects.toThrow(secret);
    expect(rg('rev-parse', 'HEAD')).toBe(before);
  });

  it('branches, then commits only the named files, with a path as the agent wrote it', async () => {
    const me = newChat('Me');
    hold.takeTurn(project.id, me.id);
    const t = tools(me);
    write('src/a.ts', 'a\n');
    write('src/b.ts', 'b\n');
    await t.make_branch({ name: 'topic' });
    const result = await t.commit_changes({
      message: 'Add a',
      paths: [join(repo.path, 'src/a.ts')],
    });
    expect(result).toMatchObject({ done: true });
    expect(rg('branch', '--show-current')).toBe('topic');
    expect(rg('show', '--name-only', '--format=', 'HEAD')).toBe('src/a.ts');
    expect(rg('ls-files', '--others', '--exclude-standard')).toBe('src/b.ts');
    await expect(t.commit_changes({ message: 'x', paths: ['../outside.txt'] })).rejects.toThrow(
      'inside Your folder',
    );
  });

  it('commits everything while the folder is shared, and warns naming the other chat', async () => {
    const me = newChat('Me');
    const other = newChat('Retry login');
    hold.takeTurn(project.id, other.id);
    expect(hold.takeTurn(project.id, me.id)).toMatchObject({ taken: true });
    write('a.txt', 'a\n');
    const result = await tools(me).commit_changes({ message: 'All of it' });
    expect(result).toHaveProperty('warning');
    expect(JSON.stringify(result)).toContain('Retry login');
    // Named paths are a chat's own, so no warning.
    write('b.txt', 'b\n');
    expect(
      await tools(me).commit_changes({ message: 'Mine', paths: ['b.txt'] }),
    ).not.toHaveProperty('warning');
  });

  // The hold is checked once before the work; a stop or a lane's start between that check and the write must not
  // let the write land in a folder the turn no longer holds.
  describe('when the turn loses Your folder after the tool checked it', () => {
    it.each([
      ['make_branch', (t: Tools) => t.make_branch({ name: 'topic' })],
      ['switch_branch', (t: Tools) => t.switch_branch({ name: 'other' })],
      ['pull', (t: Tools) => t.pull({})],
      ['commit_changes', (t: Tools) => t.commit_changes({ message: 'x' })],
    ])('%s writes nothing', async (_name, call) => {
      rg('branch', 'other');
      rg('branch', '--set-upstream-to=origin/main', 'main');
      const clone = createTempClone(pair.origin.path);
      writeFileSync(join(clone.path, 'remote.txt'), 'r\n');
      execFileSync('git', ['-C', clone.path, 'add', '-A'], { env: isolatedGitEnv() });
      execFileSync('git', ['-C', clone.path, 'commit', '-q', '-m', 'Remote'], {
        env: isolatedGitEnv(),
      });
      execFileSync('git', ['-C', clone.path, 'push', '-q', 'origin', 'main'], {
        env: { ...isolatedGitEnv(), ...NETWORK_ENV, GIT_CONFIG_GLOBAL: network.global },
      });
      clone.cleanup();
      write('mine.txt', 'mine\n');
      const me = newChat('Me');
      hold.takeTurn(project.id, me.id);
      const head = rg('rev-parse', 'HEAD');
      await expect(
        call(
          tools(me, true, () => {
            hold.releaseTurn(me.id);
          }),
        ),
      ).rejects.toThrow(/does not hold Your folder/);
      expect(rg('rev-parse', 'HEAD')).toBe(head);
      expect(rg('branch', '--show-current')).toBe('main');
      expect(rg('branch', '--list', 'topic')).toBe('');
      expect(rg('status', '--porcelain')).toBe('?? mine.txt');
    });
  });

  it('pulls, and says when a branch is behind or has no upstream', async () => {
    const me = newChat('Me');
    hold.takeTurn(project.id, me.id);
    rg('branch', '--set-upstream-to=origin/main', 'main');
    const t = tools(me);
    expect(await t.pull({})).toMatchObject({ done: true, kind: 'up_to_date' });
    rg('switch', '-q', '-c', 'loose');
    await expect(t.pull({})).rejects.toThrow('no upstream');
  });
});

describe("a chat's tools that reach GitHub", () => {
  /** The chat holds the folder on a branch of its own with one commit on it. */
  async function branchWithCommit(name = 'topic') {
    const me = newChat('Me');
    hold.takeTurn(project.id, me.id);
    const t = tools(me);
    await t.make_branch({ name });
    write('a.txt', 'a\n');
    await t.commit_changes({ message: 'Add a' });
    return t;
  }
  const originTip = (branch: string) =>
    execFileSync('git', ['--git-dir', pair.origin.path, 'rev-parse', `refs/heads/${branch}`], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    })
      .toString()
      .trim();

  it('pushes the branch under its own name, and refuses a rewritten one without forcing', async () => {
    const t = await branchWithCommit();
    await t.push_branch({});
    expect(originTip('topic')).toBe(rg('rev-parse', 'HEAD'));
    // The remote moves on; the folder rewrites its commit: the push is rejected and the remote keeps its own.
    const clone = createTempClone(pair.origin.path);
    execFileSync('git', ['-C', clone.path, 'switch', '-q', 'topic'], { env: isolatedGitEnv() });
    writeFileSync(join(clone.path, 'remote.txt'), 'r\n');
    execFileSync('git', ['-C', clone.path, 'add', '-A'], { env: isolatedGitEnv() });
    execFileSync('git', ['-C', clone.path, 'commit', '-q', '-m', 'Remote'], {
      env: isolatedGitEnv(),
    });
    execFileSync('git', ['-C', clone.path, 'push', '-q', 'origin', 'topic'], {
      env: isolatedGitEnv(),
    });
    const remote = originTip('topic');
    rg('commit', '-q', '--amend', '-m', 'Add a, rewritten');
    await expect(t.push_branch({})).rejects.toThrow();
    expect(originTip('topic')).toBe(remote);
    clone.cleanup();
  });

  it('refuses to push from, or open from, a 10db branch', async () => {
    rg('switch', '-q', '-c', '10db/pass-abc123');
    const me = newChat('Me');
    hold.takeTurn(project.id, me.id);
    const t = tools(me);
    await expect(t.push_branch({})).rejects.toThrow(/10db's own/);
    await expect(t.open_pull_request({ title: 'x', body: 'y' })).rejects.toThrow(/10db's own/);
  });

  it('opens a pull request only for a branch pushed at its commit, with the body in a file it removes', async () => {
    const t = await branchWithCommit();
    await expect(t.open_pull_request({ title: 'Add a', body: 'Why' })).rejects.toThrow(
      'push_branch',
    );
    await t.push_branch({});
    const opened = await t.open_pull_request({ title: 'Add a', body: '--body is text\nWhy' });
    const { url } = opened as { url: string };
    expect(gh.prCreates()).toEqual([
      { repo: 'acme/widgets', base: 'main', head: 'topic', title: 'Add a' },
    ]);
    expect(gh.body(url)).toBe('--body is text\nWhy');
    expect(readdirSync(join(scratch.path, 'files'))).toEqual([]);
    await expect(
      t.open_pull_request({ title: 'x', body: 'y', base: '10db/pass-abc123' }),
    ).rejects.toThrow(/10db's own/);
  });

  it('merges a pull request of this repository by number, and refuses an unknown one and 10db’s own', async () => {
    const t = await branchWithCommit();
    await t.push_branch({});
    const mine = (await t.open_pull_request({ title: 'Add a', body: 'Why' })) as { url: string };
    mkdirSync(scratch.path, { recursive: true });
    writeFileSync(join(scratch.path, 'b.md'), 'batch\n');
    const batch = await gh.prCreate({
      repo: 'acme/widgets',
      base: 'main',
      head: '10db/batch-abc123',
      title: 'Batch',
      bodyFile: join(scratch.path, 'b.md'),
    });
    await expect(
      t.merge_pull_request({ number: Number(/\/pull\/(\d+)$/.exec(batch)?.[1]) }),
    ).rejects.toThrow(/10db's own/);
    // A pull request into one of 10db's branches would merge into it, whoever opened it.
    const intoPass = await gh.prCreate({
      repo: 'acme/widgets',
      base: '10db/pass-abc123',
      head: 'topic-x',
      title: 'Into a pass',
      bodyFile: join(scratch.path, 'b.md'),
    });
    await expect(
      t.merge_pull_request({ number: Number(/\/pull\/(\d+)$/.exec(intoPass)?.[1]) }),
    ).rejects.toThrow(/merges into 10db\/pass-abc123, which is 10db's own/);
    await expect(t.merge_pull_request({ number: 99 })).rejects.toThrow('no pull request #99');
    expect(gh.merged).toEqual([]);
    const number = Number(/\/pull\/(\d+)$/.exec(mine.url)?.[1]);
    await t.merge_pull_request({ number });
    expect(gh.merged).toEqual([mine.url]);
  });
});
