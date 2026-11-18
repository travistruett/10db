import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ChatWorkStateDto, WorkPlace, type ChatDto } from '@10db/contracts';
import { setChatWork } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatRequest } from '../../test/chat-app';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { FakeGh } from '../../test/fake-gh';
import {
  createTempRepoWithOrigin,
  githubOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  tempDir,
  type TempDir,
} from '../../test/fixtures';
import { createGit } from '../git';
import { secretFilesIn } from '../sandbox';
import { createTitleRowGit, type TitleRowGit } from './title-row-git';
import { createChatWorkStateReader } from './work-state';

// The title row's Open Pull Request and Merge against a real bare origin and FakeGh: the branch that holds the
// commits, the push, the pull request, and what is left when a step fails half way.

let w: ChatWorld;
let pair: ReturnType<typeof createTempRepoWithOrigin>;
let network: ReturnType<typeof githubOrigin>;
let extra: TempDir | null = null;
let gh: FakeGh;
let titleRow: TitleRowGit;
const signal = new AbortController().signal;
const repo = (): string => pair.repo.path;

afterEach(async () => {
  await w.close();
  network.cleanup();
  pair.cleanup();
  extra?.cleanup();
  extra = null;
});

const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], {
    env: { ...isolatedGitEnv(), ...NETWORK_ENV, GIT_CONFIG_GLOBAL: network.global },
    stdio: 'pipe',
  })
    .toString()
    .trim();

function commitFile(dir: string, name: string): void {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), `${name}\n`);
  gitIn(dir, 'add', name);
  gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', `add ${name}`);
}

function setup(delivery: 'pull_request' | 'local' = 'pull_request'): ChatDto {
  pair = createTempRepoWithOrigin();
  network = githubOrigin(repo(), pair.origin.path);
  gh = new FakeGh();
  const git = createGit({ worktreeRoot: join(realpathSync(repo()), '..', 'unused') });
  const net = () => ({
    env: { ...NETWORK_ENV, GIT_CONFIG_GLOBAL: network.global },
    timeoutMs: 20_000,
  });
  w = chatWorld({
    checkout: repo(),
    project: { repoPath: repo(), delivery },
    facts: ({ state, folderHold, clock }) =>
      createChatWorkStateReader({ state, git, gh, net, folderHold, clock }),
  });
  titleRow = createTitleRowGit({
    state: w.state,
    folderHold: w.folderHold,
    work: w.work,
    git,
    gh,
    filesDir: () => join(repo(), '..', 'pr-bodies'),
    secretFilesOf: secretFilesIn,
    net,
  });
  const chat = w.open();
  w.here(chat.id);
  return chat;
}

describe('Open Pull Request', () => {
  it('pushes a branch session’s branch from its worktree and opens the pull request with its title', async () => {
    const chat = setup();
    extra = tempDir('delivery-wt');
    const path = join(realpathSync(extra.path), 'wt');
    gitIn(repo(), 'worktree', 'add', '-q', '-b', 'fix', path, 'HEAD');
    w.state.write((ctx) =>
      setChatWork(ctx, chat.id, 'here', {
        place: WorkPlace.Branch,
        branch: 'fix',
        worktreePath: path,
        baseHead: gitIn(repo(), 'rev-parse', 'HEAD'),
      }),
    );
    commitFile(path, 'done.ts');
    const state = await titleRow.openPullRequest(chat.id, signal);
    expect(gitIn(pair.origin.path, 'rev-parse', 'fix')).toBe(gitIn(path, 'rev-parse', 'HEAD'));
    expect(gh.prCreates()).toMatchObject([{ head: 'fix', base: 'main', title: 'New session' }]);
    expect(ChatWorkStateDto.parse(state)).toMatchObject({
      place: 'branch',
      pullRequest: { merged: false },
      next: 'merge',
    });
  });

  it('from main moves the commits to a new branch before main goes back to origin/main, then opens it (call 2)', async () => {
    const chat = setup();
    const origin = gitIn(repo(), 'rev-parse', 'origin/main');
    commitFile(repo(), 'a.ts');
    commitFile(repo(), 'b.ts');
    const tip = gitIn(repo(), 'rev-parse', 'HEAD');
    await titleRow.openPullRequest(chat.id, signal);
    const branch = gitIn(repo(), 'branch', '--show-current');
    expect(branch).not.toBe('main');
    expect(gitIn(repo(), 'rev-parse', 'main')).toBe(origin);
    expect(gitIn(repo(), 'rev-parse', branch)).toBe(tip);
    expect(gitIn(pair.origin.path, 'rev-parse', branch)).toBe(tip);
    expect(gh.prCreates()).toMatchObject([{ head: branch, base: 'main' }]);
  });

  it('is refused from main while the checkout has uncommitted changes, and moves nothing', async () => {
    const chat = setup();
    commitFile(repo(), 'a.ts');
    writeFileSync(join(repo(), 'wip.ts'), 'wip\n');
    const tip = gitIn(repo(), 'rev-parse', 'HEAD');
    await expect(titleRow.openPullRequest(chat.id, signal)).rejects.toThrow(/uncommitted/);
    expect(gitIn(repo(), 'rev-parse', 'main')).toBe(tip);
    expect(gitIn(repo(), 'branch', '--show-current')).toBe('main');
  });

  it('leaves the checkout on the new branch when GitHub fails, and offers Open Pull Request on it again (row 46)', async () => {
    const chat = setup();
    commitFile(repo(), 'a.ts');
    const tip = gitIn(repo(), 'rev-parse', 'HEAD');
    gh.failNext.set('prCreate', new (await import('../github')).GhError('failed', 'gh is down'));
    await expect(titleRow.openPullRequest(chat.id, signal)).rejects.toThrow('gh is down');
    const branch = gitIn(repo(), 'branch', '--show-current');
    expect(branch).not.toBe('main');
    expect(gitIn(repo(), 'rev-parse', branch)).toBe(tip);
    expect(ChatWorkStateDto.parse(await w.work.state(chat.id, signal))).toMatchObject({
      branch,
      next: 'open_pull_request',
    });
  });

  it('is refused for a project that merges locally', async () => {
    const chat = setup('local');
    commitFile(repo(), 'a.ts');
    await expect(titleRow.openPullRequest(chat.id, signal)).rejects.toThrow(/merges locally/);
  });

  it('is served by POST /chats/:chatId/pull-request', async () => {
    const chat = setup();
    commitFile(repo(), 'a.ts');
    const answer = await chatRequest(w, `/chats/${chat.id}/pull-request`, 'POST', undefined, {
      titleRow,
    });
    expect(answer.status).toBe(200);
    expect(gh.prCreates()).toHaveLength(1);
  });
});
