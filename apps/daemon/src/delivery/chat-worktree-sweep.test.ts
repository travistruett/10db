import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  mintId,
  WorkPlace,
  type ChatId,
} from '@10db/contracts';
import {
  archiveChat,
  getAppSetting,
  getChat,
  insertChat,
  insertConversation,
  listInbox,
  moveChatTab,
  setAppSetting,
  setChatWork,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv } from '../../test/fixtures';
import { chatWorktreePinKey } from '../git';
import { PrState } from '../github';
import { silentLogger } from '../log';
import { chatBranchMerged } from './chat-worktree-merged';
import { sweepWorktrees } from './worktree-sweep';

// The startup sweep removes a chat's worktree only when it is finished: the chat is archived or gone, or it is
// closed, has commits of its own and its branch is merged. Real git, a real store, a fake GitHub.

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

interface MadeChat {
  readonly id: ChatId;
  readonly path: string;
  readonly branch: string;
}

/** A chat in `place` with its worktree cut on `chat/<name>` at main, as a move leaves it. */
async function cut(
  name: string,
  place: WorkPlace = WorkPlace.Branch,
  open = false,
): Promise<MadeChat> {
  const id = mintId('Chat');
  const path = join(h.worktreeRoot, name);
  const branch = `chat/${name}`;
  const baseHead = gitIn(h.repo, 'rev-parse', 'main');
  const conversationId = h.state.write(
    (ctx) =>
      insertConversation(ctx, {
        projectId: h.project.id,
        owner: { kind: ConversationOwnerKind.Chat, id },
        profile: ConversationProfile.Explore,
        state: ConversationState.IdleCold,
      }).id,
  );
  h.state.write((ctx) => {
    insertChat(ctx, { id, projectId: h.project.id, conversationId, title: name, tabPosition: 0 });
    setChatWork(ctx, id, null, { place, worktreePath: path, branch, baseHead });
    if (!open) moveChatTab(ctx, id, null);
  });
  await h.git.addWorktree({
    repo: h.repo,
    path,
    branch,
    startPoint: baseHead,
    lockReason: `10db ${id}`,
  });
  return { id, path, branch };
}

const commitOwn = (chat: MadeChat): void => {
  writeFileSync(join(chat.path, `${chat.branch.slice(5)}.txt`), 'mine\n');
  gitIn(chat.path, 'add', '-A');
  gitIn(chat.path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'Mine');
};
const archive = (chat: MadeChat): void => {
  h.state.write((ctx) => {
    archiveChat(ctx, chat.id, ctx.now);
  });
};
const sweep = () =>
  sweepWorktrees({
    state: h.state,
    git: h.git,
    inbox: h.inbox,
    root: h.worktreeRoot,
    logger: silentLogger,
    merged: chatBranchMerged(h.ctx, new AbortController().signal),
  });
const kept = (chat: MadeChat): boolean => existsSync(chat.path);

describe('the startup sweep and a chat worktree', () => {
  describe('on a pull request project', () => {
    beforeEach(() => {
      h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    });

    it.each([
      {
        name: 'an archived chat, clean',
        setup: (c: MadeChat) => {
          archive(c);
        },
        removed: true,
      },
      {
        name: 'an open chat, merged',
        setup: (c: MadeChat) => {
          commitOwn(c);
          h.gh.openPr(c.branch, PrState.Merged);
        },
        removed: false,
        open: true,
      },
      {
        name: 'a closed chat with no commits of its own',
        setup: () => {
          // Merged by every reading, since it is at its base; it has nothing of its own.
          h.gh.openPr('chat/none', PrState.Merged);
        },
        removed: false,
        branch: 'none',
      },
      {
        name: 'a closed chat whose pull request was squash-merged',
        setup: (c: MadeChat) => {
          commitOwn(c);
          h.gh.openPr(c.branch, PrState.Merged);
        },
        removed: true,
      },
      {
        name: 'a closed chat whose branch is unmerged',
        setup: (c: MadeChat) => {
          commitOwn(c);
          h.gh.openPr(c.branch, PrState.Open);
        },
        removed: false,
      },
      {
        name: 'a closed chat with no pull request',
        setup: (c: MadeChat) => {
          commitOwn(c);
        },
        removed: false,
      },
    ])('$name', async ({ name, setup, removed, branch, open }) => {
      const chat = await cut(branch ?? name.replace(/\W+/g, '-'), WorkPlace.Branch, open === true);
      setup(chat);
      await sweep();
      expect(kept(chat)).toBe(!removed);
      const row = getChat(h.state.db, chat.id);
      if (removed) {
        expect(row.worktreePath).toBeNull();
        expect(getAppSetting(h.state.db, chatWorktreePinKey(chat.id))).toBeUndefined();
        expect(gitIn(h.repo, 'worktree', 'list')).not.toContain(realpathSync(h.worktreeRoot));
      } else {
        expect(row.worktreePath).toBe(chat.path);
      }
    });

    it('keeps a worktree whose pull request GitHub cannot be asked about', async () => {
      const chat = await cut('gh-down');
      commitOwn(chat);
      const down = Object.assign(Object.create(h.gh) as typeof h.gh, {
        prView: () => Promise.reject(new Error('gh is down')),
      });
      await sweepWorktrees({
        state: h.state,
        git: h.git,
        inbox: h.inbox,
        root: h.worktreeRoot,
        logger: silentLogger,
        merged: chatBranchMerged({ ...h.ctx, gh: down }, new AbortController().signal),
      });
      expect(kept(chat)).toBe(true);
    });

    it('keeps an archived chat with uncommitted changes, and raises the orphan card', async () => {
      const chat = await cut('dirty');
      writeFileSync(join(chat.path, 'draft.txt'), 'x\n');
      archive(chat);
      await sweep();
      expect(kept(chat)).toBe(true);
      expect(listInbox(h.state.db, { states: ['OPEN'] }).map((c) => c.title)).toEqual([
        expect.stringContaining('uncommitted changes'),
      ]);
    });

    it('never touches a chat that is moving, archived or not', async () => {
      const chat = await cut('moving', WorkPlace.Moving);
      archive(chat);
      await sweep();
      expect(kept(chat)).toBe(true);
    });

    it('removes a stale entry of a chat and leaves its live worktree, pin and path alone', async () => {
      const live = await cut('live');
      const stale = join(h.worktreeRoot, 'stale');
      await h.git.addWorktree({
        repo: h.repo,
        path: stale,
        branch: 'chat/stale',
        startPoint: gitIn(h.repo, 'rev-parse', 'main'),
        lockReason: `10db ${live.id}`,
      });
      // The live worktree's pin, as a cut records it (the harness keeps pins in memory).
      const pin = {
        gitDir: live.path,
        commonDir: h.repo,
        id: '1:1/1:1',
        fetchUrl: null,
        pushUrl: null,
      };
      h.state.write((ctx) => {
        setAppSetting(ctx, chatWorktreePinKey(live.id), pin);
      });
      await sweep();
      expect(existsSync(stale)).toBe(false);
      expect(kept(live)).toBe(true);
      expect(getChat(h.state.db, live.id).worktreePath).toBe(live.path);
      expect(getAppSetting(h.state.db, chatWorktreePinKey(live.id))).toEqual(pin);
    });

    it('removes the worktree of a chat that is gone', async () => {
      const chat = await cut('gone');
      h.state.write((ctx) => {
        setChatWork(ctx, chat.id, WorkPlace.Branch, {
          place: WorkPlace.Branch,
          worktreePath: null,
        });
      });
      await sweep();
      expect(kept(chat)).toBe(false);
    });
  });

  describe('on a local project', () => {
    beforeEach(() => {
      h = createDeliveryHarness({ workspaceMode: 'shared', delivery: 'local' }, { trigger: false });
    });

    it('removes a closed chat whose commits are in main, and keeps one whose are not', async () => {
      const merged = await cut('merged');
      const open = await cut('unmerged');
      commitOwn(merged);
      commitOwn(open);
      gitIn(
        h.repo,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'merge',
        '-q',
        '--no-edit',
        merged.branch,
      );
      await sweep();
      expect(kept(merged)).toBe(false);
      expect(kept(open)).toBe(true);
    });
  });
});
