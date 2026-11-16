import {
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  EventType,
  mintId,
  type ChatId,
  type ProjectInput,
} from '@10db/contracts';
import { getBatch, getBatchRow, getChat, insertChat, insertConversation, schema } from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { openPass, type PassOpenInput, type PutBackKeptWork } from './index';

// Sessions spec §7.3: 10db's own git work (a pass's open, a batch's cut and its switch back) never moves Your
// folder's branch under a chat's turn: it is refused or waits, naming the chat, and holds the folder itself
// while it works.

const PAGES: Partial<ProjectInput> = {
  areas: [{ name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' }],
};
const nothingKept: PutBackKeptWork = () => Promise.resolve({ applied: [], left: [] });
const LEASE = { leaseMs: 60_000, putBack: nothingKept };

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

function chat(title: string): ChatId {
  return h.state.write((ctx) => {
    const id = mintId('Chat');
    const conv = insertConversation(ctx, {
      projectId: h.project.id,
      owner: { kind: ConversationOwnerKind.Chat, id },
      profile: ConversationProfile.Explore,
      state: ConversationState.IdleCold,
    });
    return insertChat(ctx, {
      id,
      projectId: h.project.id,
      conversationId: conv.id,
      title,
      tabPosition: 0,
    }).id;
  });
}

/** Lets queued jobs and git subprocess starts run, so a job that was going to act has acted. */
async function yieldToJobs(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Sets a chat's conversation state and says so, as the engine's transition does. */
function setConversationState(chatId: ChatId, to: ConversationState): void {
  h.state.write((ctx) => {
    const row = getChat(ctx.tx, chatId);
    ctx.tx
      .update(schema.conversations)
      .set({ state: to })
      .where(eq(schema.conversations.id, row.conversationId))
      .run();
    ctx.emit({
      type: EventType.ConversationState,
      entityType: 'conversation',
      entityId: row.conversationId,
      data: { state: to },
    });
  });
}

/** What the batch says about waiting for Your folder, if it says anything. */
const waitLine = (batchId: Parameters<typeof getBatchRow>[1]): string | null =>
  getBatchRow(h.store.db, batchId).notices.find((n) => n.key === 'folder-hold')?.line ?? null;

const openInput = (extra: Partial<PassOpenInput> = {}): PassOpenInput => ({
  projectId: h.project.id,
  name: 'Polish pages',
  taskIds: [h.addTask('Settings: UI work', { areas: ['settings'] }).id],
  ...extra,
});

describe('a pass opens', () => {
  it('refused during a chat’s turn, naming the chat, and leaves no branch', async () => {
    h = createDeliveryHarness(PAGES, { trigger: false });
    const me = chat('Retry login');
    h.ctx.folderHold.takeTurn(h.project.id, me);
    await expect(openPass(h.ctx, openInput(), LEASE)).rejects.toThrow(
      /in use by the chat ‘Retry login’/,
    );
    expect(h.git$('branch', '--list', '10db/*')).toBe('');
    expect(h.git$('branch', '--show-current')).toBe('main');
  });

  it('holds the folder while its git work runs, so a take then is refused naming 10db’s work', async () => {
    const me = ((): { id: ChatId | null } => ({ id: null }))();
    const seen: string[] = [];
    h = createDeliveryHarness(PAGES, {
      trigger: false,
      wrapGit: (git) => ({
        ...git,
        openPassBranch: (input) => {
          if (me.id !== null) {
            const taken = h.ctx.folderHold.takeTurn(h.project.id, me.id);
            if (!taken.taken) seen.push(...taken.blockers.map((b) => b.holder.what ?? ''));
          }
          return git.openPassBranch(input);
        },
      }),
    });
    me.id = chat('Retry login');
    await openPass(h.ctx, openInput(), LEASE);
    expect(seen).toEqual(['opening a pass in Your folder']);
    expect(h.ctx.folderHold.holdsTurn(me.id)).toBe(false);
    expect(h.ctx.folderHold.holders(h.project.id).map((x) => x.kind)).toEqual(['pass_open']);
  });
});

describe('a batch’s cut and its switch back', () => {
  it('wait for a chat’s turn, then run, and each holds the folder while it works', async () => {
    const calls: { call: string; chatHolds: boolean }[] = [];
    const holder: { id: ChatId | null } = { id: null };
    const note = (call: string): void => {
      calls.push({
        call,
        chatHolds: holder.id !== null && h.ctx.folderHold.holdsTurn(holder.id),
      });
    };
    h = createDeliveryHarness(
      {},
      {
        wrapGit: (git) => ({
          ...git,
          switchNewBranch: (...args) => {
            note('cut');
            return git.switchNewBranch(...args);
          },
          switchBack: (...args) => {
            note('switch back');
            return git.switchBack(...args);
          },
        }),
      },
    );
    holder.id = chat('Retry login');
    h.ctx.folderHold.takeTurn(h.project.id, holder.id);
    const task = h.addTask('Alpha');
    const started = h.only(
      h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] }),
    );
    await yieldToJobs();
    expect(calls).toEqual([]);
    expect(getBatch(h.store.db, started.id).state).toBe('CUTTING');
    expect(waitLine(started.id)).toBe(
      'Waits for the chat ‘Retry login’ to finish with Your folder',
    );
    h.ctx.folderHold.releaseTurn(holder.id);
    await h.jobs.idle();
    expect(waitLine(started.id)).toBeNull();
    expect(calls).toEqual([{ call: 'cut', chatHolds: false }]);
    expect(getBatch(h.store.db, started.id).state).toBe('OPEN');
    expect(h.ctx.folderHold.holders(h.project.id).map((x) => x.kind)).toEqual(['lane']);

    // The switch back waits for a chat taken over in the builder's terminal: no turn can hold the folder
    // while the batch's own row does, so a takeover is who can be there.
    h.commit('src/api/alpha.txt');
    const terminal = chat('In terminal');
    setConversationState(terminal, ConversationState.TakenOver);
    h.shipper.abandon(started.id);
    await yieldToJobs();
    expect(calls).toHaveLength(1);
    expect(waitLine(started.id)).toBe(
      'Waits for the chat ‘In terminal’ in your terminal to finish with Your folder',
    );
    setConversationState(terminal, ConversationState.IdleCold);
    await h.jobs.idle();
    expect(waitLine(started.id)).toBeNull();
    expect(calls).toEqual([
      { call: 'cut', chatHolds: false },
      { call: 'switch back', chatHolds: false },
    ]);
    expect(h.git$('branch', '--show-current')).toBe('main');
    expect(h.ctx.folderHold.holders(h.project.id)).toEqual([]);
  });

  it('a switch back waiting for a terminal stops with the jobs and keeps its place', async () => {
    h = createDeliveryHarness({});
    const task = h.addTask('Alpha');
    const started = h.only(
      h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] }),
    );
    await h.jobs.idle();
    h.commit('src/api/alpha.txt');
    const terminal = chat('In terminal');
    setConversationState(terminal, ConversationState.TakenOver);
    h.shipper.abandon(started.id);
    await yieldToJobs();
    expect(waitLine(started.id)).not.toBeNull();
    await h.jobs.stop();
    expect(getBatchRow(h.store.db, started.id).returnSha).not.toBeNull();
    expect(waitLine(started.id)).toBeNull();
    expect(h.ctx.folderHold.holders(h.project.id).map((x) => x.kind)).not.toContain('git_work');
  });
});
