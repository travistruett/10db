import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Delivery, WorkstreamState, type DoItPreviewDto } from '@10db/contracts';
import { insertTask, insertWorkstream, schema } from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { previewDoIt, type DoItDeps } from '../src/chat';
import { passBelow, passOpenProblem, returnBranchProblem } from '../src/delivery';
import { createPendingOpens } from '../src/pass';
import { createGit } from '../src/git';
import { chatWorld, type ChatWorld } from './chat-world';
import { createTempRepo, isolatedGitEnv, type TempDir } from './fixtures';
import { execFileSync } from 'node:child_process';

// Sessions spec §7.3: the sheet reads where Do It can go before it is pressed, on a real repository,
// the real hold and the real pass rules.

let w: ChatWorld;
let repo: TempDir;
afterEach(async () => {
  await w.close();
  repo.cleanup();
});

const git$ = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv() })
    .toString()
    .trim();

function world(project: { delivery?: Delivery } = {}): ChatWorld {
  repo = createTempRepo();
  w = chatWorld({
    checkout: repo.path,
    project: { repoPath: repo.path, delivery: Delivery.PullRequest, ...project },
  });
  return w;
}

function preview(chat: ReturnType<ChatWorld['open']>): Promise<DoItPreviewDto> {
  const deps: DoItDeps = {
    state: w.state,
    engine: w.engine,
    folderHold: w.folderHold,
    pendingOpens: createPendingOpens({ state: w.state }),
    git: createGit({}),
    chat: w.chat,
    openProblem: passOpenProblem,
    returnBranchProblem,
    stacksOn: (db, project) => passBelow(db, project.id)?.name ?? null,
  };
  return previewDoIt(deps, chat.id);
}

function write(path: string, content: string): void {
  const file = join(repo.path, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('the Do It preview', () => {
  it('offers both places on a clean folder, listing the uncommitted files', async () => {
    world();
    const chat = w.open();
    write('notes.md', 'n');

    const read = await preview(chat);

    expect(read.here).toMatchObject({ offered: true, refusal: null });
    expect(read.worktree).toMatchObject({ offered: true, refusal: null });
    expect(read.changed).toEqual([{ path: 'notes.md', status: '?' }]);
    expect(read).toMatchObject({ more: 0, runningTurn: false, stacksOn: null, leftOut: null });
    expect(read.base).toBe('main');
  });

  it('offers neither place while a Do It has the chat stopped, and still answers when the folder cannot be read', async () => {
    world();
    const chat = w.open();
    const release = await w.chat.stopForOpen(chat.id);

    const doing = await preview(chat);

    expect(doing.here).toMatchObject({ offered: false, refusal: { code: 'under_way' } });
    expect(doing.worktree).toMatchObject({ offered: false, refusal: { code: 'under_way' } });
    release();
    rmSync(repo.path, { recursive: true, force: true });
    const unreadable = await preview(chat);
    expect(unreadable.changed).toEqual([]);
  });

  it('refuses here naming a lane in the folder, and offers whenBusy for another chat’s turn only', async () => {
    world();
    const chat = w.open(0);
    const other = w.open(1);
    w.state.write((ctx) => {
      const task = insertTask(ctx, w.project.id, {
        title: 'Bump vite',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      });
      const ws = insertWorkstream(ctx, task.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      ctx.tx
        .update(schema.workstreams)
        .set({ state: WorkstreamState.Running, workspaceMode: 'shared' })
        .where(eq(schema.workstreams.id, ws.id))
        .run();
    });
    const withLane = await preview(chat);
    expect(withLane.here).toMatchObject({
      offered: false,
      whenBusy: false,
      refusal: { code: 'pass' },
    });
    expect(withLane.here.refusal?.message).toMatch(/running in Your folder/);
    expect(withLane.worktree.offered).toBe(true);
    w.state.write((ctx) => {
      ctx.tx.update(schema.workstreams).set({ state: WorkstreamState.Done }).run();
    });

    w.folderHold.takeTurn(w.project.id, other.id);
    const withChat = await preview(chat);
    expect(withChat.here).toMatchObject({
      offered: false,
      whenBusy: true,
      refusal: { code: 'folder_in_use' },
    });
    expect(withChat.here.refusal?.message).toContain(other.title);
    w.folderHold.releaseTurn(other.id);
  });

  it.each([
    {
      name: 'in the middle of a merge',
      arrange: () => {
        write('.git/MERGE_HEAD', 'x\n');
      },
      code: 'operation',
    },
    {
      name: 'on a detached HEAD',
      arrange: () => git$('checkout', '-q', '--detach'),
      code: 'detached',
    },
    {
      name: 'on a 10db branch no task names',
      arrange: () => git$('switch', '-q', '-c', '10db/stray'),
      code: 'return_branch',
    },
  ])('refuses here $name, saying so', async ({ arrange, code }) => {
    world();
    const chat = w.open();
    arrange();

    const read = await preview(chat);

    expect(read.here).toMatchObject({ offered: false, refusal: { code } });
    expect(read.worktree.offered).toBe(true);
  });

  it('has no separate copy on a local project, and says why', async () => {
    world({ delivery: Delivery.Local });
    const read = await preview(w.open());
    expect(read.worktree).toMatchObject({ offered: false, refusal: { code: 'local' } });
    expect(read).toMatchObject({ base: null, leftOut: null });
    expect(read.here.offered).toBe(true);
  });

  it('names the commits a copy leaves out when the folder is ahead of origin’s base', async () => {
    world();
    const origin = createTempRepo();
    git$('remote', 'add', 'origin', origin.path);
    git$('fetch', '-q', 'origin');
    git$('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git$('switch', '-q', '-c', 'feature');
    for (const name of ['a', 'b']) {
      write(`${name}.txt`, name);
      git$('add', `${name}.txt`);
      git$('commit', '-q', '-m', name);
    }

    const read = await preview(w.open());

    expect(read.leftOut).toEqual({ branch: 'feature', count: 2 });
    origin.cleanup();
  });
});
