import { execFileSync } from 'node:child_process';
import { realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkPlace, WorkstreamChangesDto } from '@10db/contracts';
import { setChatWork } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatRequest } from '../../test/chat-app';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { createTempRepo, isolatedGitEnv, tempDir, type TempDir } from '../../test/fixtures';

// The drawer's Changes for a session, on a real repository: the same answer a Board task's Changes gives, read
// from the session's root against where its work began.

let w: ChatWorld;
let repo: TempDir;
let extra: TempDir | null = null;
afterEach(async () => {
  await w.close();
  repo.cleanup();
  extra?.cleanup();
  extra = null;
});

const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

function commitFile(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text);
  gitIn(dir, 'add', name);
  gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', `add ${name}`);
}

const changesOf = async (chatId: string) => {
  const answer = await chatRequest(w, `/chats/${chatId}/changes`, 'GET');
  return { status: answer.status, body: await answer.json() };
};

function setup() {
  repo = createTempRepo();
  w = chatWorld({ checkout: repo.path, project: { repoPath: repo.path } });
  return w.open();
}

/** A worktree on a new branch from HEAD, recorded as the session's. */
function onBranch(chatId: Parameters<typeof setChatWork>[1], keepWorktree = true) {
  const baseHead = gitIn(repo.path, 'rev-parse', 'HEAD');
  extra = tempDir('chat-changes-wt');
  const path = join(realpathSync(extra.path), 'wt');
  gitIn(repo.path, 'worktree', 'add', '-q', '-b', 'fix', path, 'HEAD');
  w.state.write((ctx) =>
    setChatWork(ctx, chatId, null, {
      place: WorkPlace.Branch,
      branch: 'fix',
      worktreePath: keepWorktree ? path : null,
      baseHead,
    }),
  );
  return { path, baseHead };
}

describe('GET /chats/:chatId/changes', () => {
  it('shows a Here session’s uncommitted work against HEAD: edits, new files and deletions', async () => {
    const chat = setup();
    w.here(chat.id);
    const head = gitIn(repo.path, 'rev-parse', 'HEAD');
    const tracked = gitIn(repo.path, 'ls-files').split('\n')[0] ?? '';
    writeFileSync(join(repo.path, 'new.ts'), 'export const n = 1;\n');
    unlinkSync(join(repo.path, tracked));
    const { status, body } = await changesOf(chat.id);
    expect(status).toBe(200);
    const changes = WorkstreamChangesDto.parse(body);
    expect(changes.baseHead).toBe(head);
    expect(changes.files.map((f) => f.path).sort()).toEqual([tracked, 'new.ts'].sort());
    expect(changes.diff).toContain('+export const n = 1;');
    expect(changes.commits).toEqual([]);
    // Reading it moved nothing in the checkout.
    expect(gitIn(repo.path, 'status', '--porcelain').split('\n')).toHaveLength(2);
    expect(gitIn(repo.path, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('shows a branch session its worktree: commits since base_head and what is still uncommitted', async () => {
    const chat = setup();
    const { path, baseHead } = onBranch(chat.id);
    commitFile(path, 'done.ts', 'export const done = true;\n');
    writeFileSync(join(path, 'wip.ts'), 'export const wip = 1;\n');
    // The builder's own change in the checkout is not this session's.
    writeFileSync(join(repo.path, 'builders.txt'), 'the builder’s\n');
    const { status, body } = await changesOf(chat.id);
    expect(status).toBe(200);
    const changes = WorkstreamChangesDto.parse(body);
    expect(changes.baseHead).toBe(baseHead);
    expect(changes.files.map((f) => f.path).sort()).toEqual(['done.ts', 'wip.ts']);
    expect(changes.commits).toHaveLength(1);
    expect(changes.diff).not.toContain('builders.txt');
  });

  it('shows a branch with no worktree its committed work only, read from the branch', async () => {
    const chat = setup();
    const { path, baseHead } = onBranch(chat.id);
    commitFile(path, 'done.ts', 'export const done = true;\n');
    w.state.write((ctx) =>
      setChatWork(ctx, chat.id, WorkPlace.Branch, { place: WorkPlace.Branch, worktreePath: null }),
    );
    const { status, body } = await changesOf(chat.id);
    expect(status).toBe(200);
    const changes = WorkstreamChangesDto.parse(body);
    expect(changes.baseHead).toBe(baseHead);
    expect(changes.files.map((f) => f.path)).toEqual(['done.ts']);
  });

  it.each<{ name: string; place: WorkPlace | null; words: string }>([
    {
      name: 'a session that has changed nothing',
      place: null,
      words: 'This session has not changed any files yet.',
    },
    {
      name: 'a session that is choosing',
      place: WorkPlace.Choosing,
      words: 'This session has not changed any files yet.',
    },
    {
      name: 'a session that is moving',
      place: WorkPlace.Moving,
      words: 'Wait for the move to finish.',
    },
  ])('is refused for $name', async ({ place, words }) => {
    const chat = setup();
    if (place !== null)
      w.state.write((ctx) => setChatWork(ctx, chat.id, null, { place, branch: 'fix' }));
    const { status, body } = await changesOf(chat.id);
    expect(status).toBe(409);
    expect(JSON.stringify(body)).toContain(words);
  });
});
