import {
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  mintId,
  type ChatId,
} from '@10db/contracts';
import {
  deleteCuttingBatch,
  insertBatch,
  insertChat,
  insertConversation,
  patchConversation,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { waitForAsync } from '../../test/fixtures';
import { reserveGitNaming } from './folder-wait';

// Sessions spec §7.3: a wait that ends in an error leaves no git work holding Your folder.

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

describe('reserveGitNaming', () => {
  it('releases the folder it was handed when taking its notice off the batch fails', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const batch = h.state.write((ctx) =>
      insertBatch(ctx, { projectId: h.project.id, title: 'Waiting', baseBranch: 'main' }),
    );
    const chatId: ChatId = mintId('Chat');
    const conversationId = h.state.write((ctx) => {
      const conv = insertConversation(ctx, {
        projectId: h.project.id,
        owner: { kind: ConversationOwnerKind.Chat, id: chatId },
        profile: ConversationProfile.Explore,
        state: ConversationState.TakenOver,
      });
      insertChat(ctx, {
        id: chatId,
        projectId: h.project.id,
        conversationId: conv.id,
        title: 'In terminal',
        tabPosition: 0,
      });
      return conv.id;
    });
    const waiting = reserveGitNaming(h.ctx, {
      projectId: h.project.id,
      batchId: batch.id,
      what: 'a switch back',
    });
    const outcome = waiting.then(
      () => 'reserved',
      () => 'rejected',
    );
    // The batch goes while the wait runs, so the notice's removal fails once the folder is handed over.
    h.state.write((ctx) => {
      deleteCuttingBatch(ctx, batch.id, 'gone');
    });
    h.ctx.folderHold.handBack(h.project.id, chatId, () => {
      h.state.write((ctx) => {
        patchConversation(ctx, conversationId, { state: ConversationState.IdleCold });
      });
    });
    expect(await outcome).toBe('rejected');
    const next = await waitForAsync(
      () => Promise.resolve(h.ctx.folderHold.reserveGit(h.project.id, 'another')),
      5_000,
    );
    expect(next.reserved).toBe(true);
  });
});
