import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChatWorkStateDto,
  ConversationItemAuthor,
  Delivery,
  ConversationItemKind,
  EditChange,
  ToolCallKind,
  ToolCallStatus,
  WorkPlace,
  type ChatDto,
} from '@10db/contracts';
import { insertItem, setChatWork } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatRequest } from '../../test/chat-app';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { FakeGh } from '../../test/fake-gh';
import { createTempRepo, isolatedGitEnv, tempDir, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
import type { CheckRollupEntry } from '../github';
import {
  createChatWorkStateReader,
  PULL_REQUEST_READ_MS,
  type ChatWorkStateReader,
} from './work-state';

// The title row's facts on real git, a real store and FakeGh: what a session changed, what is ahead, who has the
// checkout, and one GitHub read per branch for a while.

let w: ChatWorld;
let repo: TempDir;
let extra: TempDir | null = null;
let gh: FakeGh;
let reader: ChatWorkStateReader;
const signal = new AbortController().signal;

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

function commitFile(dir: string, name: string, text = 'x'): void {
  writeFileSync(join(dir, name), text);
  gitIn(dir, 'add', name);
  gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', `add ${name}`);
}

/** A project on GitHub, its checkout on `main` with `origin/main` at the commit it is on. */
function setup(delivery: Delivery = Delivery.PullRequest): ChatDto {
  repo = createTempRepo();
  gitIn(repo.path, 'config', 'remote.origin.url', 'https://github.com/acme/widgets.git');
  gitIn(repo.path, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  gh = new FakeGh();
  w = chatWorld({
    checkout: repo.path,
    project: { repoPath: repo.path, delivery },
    facts: ({ state, folderHold, clock }) => {
      reader = createChatWorkStateReader({
        state,
        git: createGit({ worktreeRoot: join(realpathSync(repo.path), '..', 'unused') }),
        gh,
        net: () => ({ env: {}, timeoutMs: 5_000 }),
        folderHold,
        clock,
      });
      return reader;
    },
  });
  return w.open();
}

const read = async (chat: ChatDto, moveFailure: string | null = null) =>
  ChatWorkStateDto.parse(await reader.read(chat.id, signal, moveFailure));

const editCall = (path: string) => ({
  id: `edit-${path}`,
  harnessTool: 'Edit',
  kind: ToolCallKind.Edit,
  status: ToolCallStatus.Done,
  title: path,
  startedAt: '2026-11-17T10:00:00.000Z',
  durationMs: 5,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
  path,
  change: EditChange.Update,
  movePath: null,
  hunks: [],
  addedLines: 1,
  removedLines: 0,
  truncated: false,
});

const checkRun = (name: string, conclusion: string | null): CheckRollupEntry => ({
  __typename: 'CheckRun',
  name,
  status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion,
  detailsUrl: null,
});

describe('a session that has not started changing files', () => {
  it('reads nothing of git and offers no step', async () => {
    const chat = setup();
    writeFileSync(join(repo.path, 'mine.txt'), 'the builder’s');
    expect(await read(chat)).toMatchObject({
      place: null,
      dirtyFiles: 0,
      ahead: 0,
      touched: [],
      pullRequest: null,
      next: null,
      refusal: null,
      uncommittedInCheckout: 1,
    });
  });

  it('says to wait while it moves, and shows a failed move’s words while it chooses', async () => {
    const chat = setup();
    w.state.write((ctx) => setChatWork(ctx, chat.id, null, { place: WorkPlace.Choosing }));
    expect(await read(chat, 'git could not cut the worktree')).toMatchObject({
      place: 'choosing',
      next: null,
      refusal: 'git could not cut the worktree',
    });
    w.state.write((ctx) =>
      setChatWork(ctx, chat.id, WorkPlace.Choosing, { place: WorkPlace.Moving, branch: 'fix' }),
    );
    expect(await read(chat)).toMatchObject({
      place: 'moving',
      next: null,
      refusal: 'Wait for the move to finish.',
    });
  });
});

describe('a session working here', () => {
  it('offers Commit, and lists the files its allowed edits touched apart from the builder’s own', async () => {
    const chat = setup();
    w.here(chat.id);
    writeFileSync(join(repo.path, 'a.ts'), 'a');
    writeFileSync(join(repo.path, 'b.txt'), 'the builder’s');
    w.state.write((ctx) =>
      insertItem(ctx, chat.conversationId, {
        author: ConversationItemAuthor.Agent,
        kind: ConversationItemKind.ToolCall,
        body: editCall(join(repo.path, 'a.ts')),
      }),
    );
    expect(await read(chat)).toMatchObject({
      place: 'here',
      branch: 'main',
      baseBranch: 'main',
      dirtyFiles: 2,
      touched: ['a.ts'],
      uncommittedInCheckout: 1,
      next: 'commit',
      refusal: null,
    });
  });

  it('offers Open Pull Request for commits that are not on one yet', async () => {
    const chat = setup();
    w.here(chat.id);
    commitFile(repo.path, 'a.ts');
    expect(await read(chat)).toMatchObject({
      dirtyFiles: 0,
      ahead: 1,
      pullRequest: null,
      next: 'open_pull_request',
    });
  });

  it('names a holder of the checkout and refuses the step with its words', async () => {
    const chat = setup();
    w.here(chat.id);
    commitFile(repo.path, 'a.ts');
    // Another session in the builder's terminal holds the checkout.
    const other = w.open(1);
    const token = w.folderHold.reserveGit(w.project.id, 'warming up');
    w.chat.send(other.conversationId, { text: 'Hello', mentions: [], pictures: [] });
    await w.engine.settled(other.conversationId);
    if (token.reserved) w.folderHold.releaseGit(token.token);
    await w.takeover.open(other.conversationId);
    const held = await read(chat);
    expect(held.holder).toMatch(/is in your terminal, on `main`\.$/);
    expect(held).toMatchObject({ next: 'open_pull_request', refusal: held.holder });
  });
});

describe('a project that merges locally', () => {
  it('offers Merge into main for a branch session once its checkout is clean and on main', async () => {
    const chat = setup(Delivery.Local);
    const baseHead = gitIn(repo.path, 'rev-parse', 'HEAD');
    extra = tempDir('work-state-local');
    const path = join(realpathSync(extra.path), 'wt');
    gitIn(repo.path, 'worktree', 'add', '-q', '-b', 'fix', path, 'HEAD');
    w.state.write((ctx) =>
      setChatWork(ctx, chat.id, null, {
        place: WorkPlace.Branch,
        branch: 'fix',
        worktreePath: path,
        baseHead,
      }),
    );
    commitFile(path, 'done.ts');
    expect(await read(chat)).toMatchObject({ ahead: 1, next: 'merge_local', refusal: null });
    writeFileSync(join(repo.path, 'builders.txt'), 'the builder’s');
    expect(await read(chat)).toMatchObject({
      next: 'merge_local',
      refusal: 'Your checkout has uncommitted changes, so it can’t take a merge.',
    });
  });

  it('says a here session on its own branch must have the checkout on main', async () => {
    const chat = setup(Delivery.Local);
    w.here(chat.id);
    gitIn(repo.path, 'switch', '-qc', 'topic');
    commitFile(repo.path, 'a.ts');
    expect(await read(chat)).toMatchObject({
      next: 'merge_local',
      refusal: 'Your checkout is on `topic`; it must be on `main` to take the merge.',
    });
  });
});

describe('the pull request', () => {
  function onTopic(): { chat: ChatDto; url: string } {
    const chat = setup();
    w.here(chat.id);
    gitIn(repo.path, 'switch', '-qc', 'topic');
    commitFile(repo.path, 'a.ts');
    return { chat, url: gh.openPr('topic') };
  }
  const prViews = (): number => gh.calls.filter((c) => c.method === 'prView').length;

  it('shows its number, checks and whether it can merge, and offers Merge when they allow it', async () => {
    const { chat, url } = onTopic();
    gh.setChecks(url, [checkRun('build', 'SUCCESS'), checkRun('lint', 'SUCCESS')]);
    expect(await read(chat)).toMatchObject({
      branch: 'topic',
      pullRequest: {
        number: 1,
        url,
        checks: { passed: 2, total: 2, failing: 0 },
        mergeable: true,
        merged: false,
      },
      next: 'merge',
      refusal: null,
    });
  });

  it('disables Merge with the count while checks run', async () => {
    const { chat, url } = onTopic();
    gh.setChecks(url, [checkRun('build', 'SUCCESS'), checkRun('lint', null)]);
    expect(await read(chat)).toMatchObject({ next: 'merge', refusal: 'Checks running · 1/2' });
  });

  it('reads GitHub once per branch for two minutes, and again after the interval or a forget', async () => {
    const { chat } = onTopic();
    await read(chat);
    await read(chat);
    expect(prViews()).toBe(1);
    w.clock.advance(PULL_REQUEST_READ_MS - 1_000);
    await read(chat);
    expect(prViews()).toBe(1);
    // A pull request just opened or merged is read afresh.
    reader.forgetPullRequest(w.project.id, 'topic');
    await read(chat);
    expect(prViews()).toBe(2);
    w.clock.advance(PULL_REQUEST_READ_MS);
    await read(chat);
    expect(prViews()).toBe(3);
  });

  it('shows a merged pull request as merged, with nothing left to do', async () => {
    const { chat, url } = onTopic();
    gh.merged.push(url);
    gh.setState(url, 'MERGED');
    expect(await read(chat)).toMatchObject({
      pullRequest: { merged: true },
      next: null,
    });
  });

  it('reads no pull request for a branch GitHub has none for', async () => {
    const chat = setup();
    w.here(chat.id);
    gitIn(repo.path, 'switch', '-qc', 'lonely');
    commitFile(repo.path, 'a.ts');
    expect(await read(chat)).toMatchObject({ pullRequest: null, next: 'open_pull_request' });
  });
});

describe('a session on its own branch', () => {
  it('reads its worktree: its changes and commits, and the checkout’s own changes apart', async () => {
    const chat = setup();
    const baseHead = gitIn(repo.path, 'rev-parse', 'HEAD');
    extra = tempDir('work-state-worktree');
    const path = join(realpathSync(extra.path), 'wt');
    gitIn(repo.path, 'worktree', 'add', '-q', '-b', 'fix', path, 'HEAD');
    w.state.write((ctx) =>
      setChatWork(ctx, chat.id, null, {
        place: WorkPlace.Branch,
        branch: 'fix',
        worktreePath: path,
        baseHead,
      }),
    );
    commitFile(path, 'done.ts');
    writeFileSync(join(path, 'wip.ts'), 'wip');
    writeFileSync(join(repo.path, 'builders.txt'), 'the builder’s');
    expect(await read(chat)).toMatchObject({
      place: 'branch',
      branch: 'fix',
      base: baseHead,
      dirtyFiles: 1,
      ahead: 1,
      uncommittedInCheckout: 1,
      holder: null,
      next: 'commit',
    });
  });
});

describe('GET /chats/:chatId/work', () => {
  it('serves the facts through the real app, with a failed move’s words', async () => {
    const chat = setup();
    w.here(chat.id);
    writeFileSync(join(repo.path, 'a.ts'), 'a');
    const answer = await chatRequest(w, `/chats/${chat.id}/work`, 'GET');
    expect(answer.status).toBe(200);
    expect(ChatWorkStateDto.parse(await answer.json())).toMatchObject({
      place: 'here',
      dirtyFiles: 1,
      next: 'commit',
    });
  });
});
