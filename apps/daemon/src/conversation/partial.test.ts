import { mintId, type LiveItemDto, type ToolCallView } from '@10db/contracts';
import {
  createTestStore,
  insertItem,
  insertShape,
  listItems,
  seedProject,
  shapeConversation,
} from '@10db/db';
import { describe, expect, it } from 'vitest';
import { partialItems, storePartial } from './partial';

// Sessions spec §6.3: what a turn streamed is kept when it ends early, marked partial, and a call
// still running reads failed.

const NOW = '2026-11-13T10:00:00.000Z';
const command: ToolCallView = {
  kind: 'command',
  id: 'toolu_1',
  harnessTool: 'Bash',
  status: 'running',
  title: 'pnpm test',
  startedAt: NOW,
  durationMs: null,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
  command: 'pnpm test',
  cwd: null,
  outputTail: '',
  outputBytes: 0,
  exitCode: null,
};
const id = () => mintId('ConversationItem');

describe('partialItems', () => {
  it.each<{ name: string; live: LiveItemDto; stored: object | null }>([
    {
      name: 'an agent text is kept, partial',
      live: { itemId: id(), kind: 'agent_message', text: 'Half a sen' },
      stored: {
        kind: 'agent_message',
        author: 'agent',
        partial: true,
        body: { text: 'Half a sen' },
      },
    },
    {
      name: 'reasoning is kept, partial',
      live: { itemId: id(), kind: 'reasoning', text: 'Thinking' },
      stored: { kind: 'reasoning', partial: true, body: { text: 'Thinking' } },
    },
    {
      name: 'a running call reads failed, keeping its output tail',
      live: { itemId: id(), kind: 'tool_call', call: command, output: 'ok\n', outputOffset: 0 },
      stored: {
        kind: 'tool_call',
        partial: true,
        body: { ...command, status: 'failed', outputTail: 'ok\n' },
      },
    },
    {
      name: 'an empty text stores nothing',
      live: { itemId: id(), kind: 'agent_message', text: '' },
      stored: null,
    },
  ])('$name', ({ live, stored }) => {
    const items = partialItems([live]);
    expect(items).toEqual(
      stored === null ? [] : [expect.objectContaining({ id: live.itemId, ...stored })],
    );
  });
});

describe('storePartial', () => {
  it('stores them under their live ids, after the conversation’s last item', () => {
    const { store, close } = createTestStore();
    try {
      const project = seedProject(store, { name: 'alpha' });
      const conversation = store.write((ctx) =>
        shapeConversation(ctx.tx, insertShape(ctx, project.id, { title: 'P', origin: 'app' }).id),
      ).value.id;
      store.write((ctx) =>
        insertItem(ctx, conversation, { author: 'builder', kind: 'message', body: { text: 'Go' } }),
      );
      const live: LiveItemDto = { itemId: id(), kind: 'agent_message', text: 'Half' };
      const ids = store.write((ctx) => storePartial(ctx, conversation, [live])).value;
      expect(ids).toEqual([live.itemId]);
      expect(listItems(store.db, conversation).map((i) => [i.id, i.seq, i.partial])).toEqual([
        [expect.any(String), 1, false],
        [live.itemId, 2, true],
      ]);
    } finally {
      close();
    }
  });
});
