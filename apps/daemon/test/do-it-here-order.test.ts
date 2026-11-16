import { ConflictError, DoItPlace, type ChatId } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createGit } from '../src/git';
import { silentLogger } from '../src/log';
import { createPendingOpens, type OpenWhenBusyDeps } from '../src/pass';
import { doItHere, type DoItHereDeps } from '../src/chat';
import { chatWorld, type ChatWorld } from './chat-world';
import { createTempRepo, waitFor, type TempDir } from './fixtures';

// Do It Here's order of steps: what refuses the open does so before the chat's own turn is stopped, and
// what a wait for other chats' turns re-reads is read after that stop.

let w: ChatWorld;
let repo: TempDir;
afterEach(async () => {
  await w.close();
  repo.cleanup();
});

/** Two chats of one project with their turns running, so the folder is held by chats alone. */
async function twoRunningChats(): Promise<{ mine: ChatId; other: ChatId; release: () => void }> {
  repo = createTempRepo();
  w = chatWorld({ checkout: repo.path, project: { repoPath: repo.path } });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  w.adapter.shapeBehaviour = async () => {
    await gate;
    return { text: 'Done.' };
  };
  const mine = w.open();
  const other = w.open(1);
  for (const chat of [mine, other])
    w.chat.send(chat.conversationId, { text: 'Working', mentions: [], pictures: [] });
  await waitFor(() => w.engine.view(mine.conversationId).state === 'running' || undefined);
  await waitFor(() => w.engine.view(other.conversationId).state === 'running' || undefined);
  return { mine: mine.id, other: other.id, release };
}

function depsOf(over: {
  draining: boolean;
  openProblem: DoItHereDeps['openProblem'];
}): DoItHereDeps {
  const pendingOpens = createPendingOpens({ state: w.state });
  const openWhenBusy: OpenWhenBusyDeps = {
    folderHold: w.folderHold,
    pendingOpens,
    stopChatForOpen: (chatId) => w.chat.stopForOpen(chatId),
    logger: silentLogger,
    draining: () => over.draining,
    notify: () => undefined,
  };
  return {
    state: w.state,
    engine: w.engine,
    folderHold: w.folderHold,
    pendingOpens,
    git: createGit(),
    chat: w.chat,
    openProblem: over.openProblem,
    returnBranchProblem: () => null,
    stacksOn: () => null,
    openWhenBusy,
    openWholeProject: () => Promise.reject(new Error('the open was not expected to run')),
  };
}

describe('Do It in Your folder: the order of its steps', () => {
  it('refuses a wait during an update before stopping the chat’s own turn', async () => {
    const { mine, release } = await twoRunningChats();
    const deps = depsOf({ draining: true, openProblem: () => null });

    await expect(
      doItHere(deps, mine, { place: DoItPlace.Here, title: 'T', brief: 'b', whenBusy: 'wait' }),
    ).rejects.toThrow(/about to update/);

    expect(w.chat.underWay(mine)).toBe(false);
    expect(w.engine.view(w.chat.get(mine).conversationId).state).toBe('running');
    release();
  });

  it('reads the open’s refusals again after the stop, before it answers pending', async () => {
    const { mine, release } = await twoRunningChats();
    let reads = 0;
    const deps = depsOf({
      draining: false,
      // The first read is the sheet's; a lane starting while the own turn stops shows in the next.
      openProblem: () => (++reads === 1 ? null : '1 task is running in Your folder'),
    });

    await expect(
      doItHere(deps, mine, { place: DoItPlace.Here, title: 'T', brief: 'b', whenBusy: 'wait' }),
    ).rejects.toThrow(ConflictError);

    expect(deps.pendingOpens.get(w.project.id)).toBeNull();
    release();
  });
});
