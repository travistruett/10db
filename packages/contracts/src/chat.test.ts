import { describe, expect, it } from 'vitest';
import {
  ChatCreateInput,
  ChatDto,
  ChatPatchInput,
  ChatToolInputs,
  ChatToolResult,
  ConversationFilesQuery,
  ConversationItemBody,
  cutTitle,
  mintId,
  PostConversationMessage,
} from './index';

// Sessions spec §10, §11: the wire shapes Sessions reads, and what the chat's tools return.

const AT = '2026-11-13T10:00:00.000Z';
const capabilities = {
  harness: 'claude',
  label: 'Claude Code',
  steer: 'inject',
  receipts: true,
  readBack: true,
  images: ['png'],
  slashCommands: true,
  plan: true,
  reasoning: true,
  subagents: true,
  backgroundTasks: true,
  webSearch: true,
  modelSwitch: 'next_turn',
  takeover: true,
  costUsd: false,
  judge: 'native',
};
const conversationId = mintId('Conversation');
const chat = {
  id: mintId('Chat'),
  projectId: mintId('Project'),
  conversationId,
  conversation: {
    id: conversationId,
    owner: { kind: 'chat', id: 'cht_x' },
    state: 'idle_cold',
    capabilities,
    model: null,
    effort: null,
    contextPct: null,
    queued: 0,
    costUsd: null,
    sendNow: false,
    pausedUntil: null,
    commands: [{ name: 'compact', description: 'Compact', argumentHint: null }],
  },
  title: 'New session',
  titleSource: 'agent',
  mode: 'explore',
  taskId: null,
  passId: null,
  tabPosition: 0,
  createdAt: AT,
  lastActivityAt: null,
  archivedAt: null,
  lastReplyAt: null,
  tasksFiled: 0,
};
const taskId = mintId('Task');

describe('chat contracts', () => {
  it.each<{
    name: string;
    schema: { safeParse(v: unknown): { success: boolean } };
    value: unknown;
  }>([
    { name: 'a ChatDto', schema: ChatDto, value: chat },
    {
      name: 'a task result',
      schema: ChatToolResult,
      value: { kind: 'task', taskId, title: 'Retry', column: 'Ready' },
    },
    {
      name: 'a task_edit result',
      schema: ChatToolResult,
      value: { kind: 'task_edit', taskId, title: 'Retry', previous: { title: 'Old' } },
    },
    {
      name: 'a title result',
      schema: ChatToolResult,
      value: { kind: 'title', title: 'Login', previousTitle: 'New session' },
    },
    {
      name: 'a start result',
      schema: ChatToolResult,
      value: { kind: 'start', taskId, started: true },
    },
    {
      name: 'a patch that only closes the tab',
      schema: ChatPatchInput,
      value: { tabPosition: null },
    },
    {
      name: 'a model_change notice',
      schema: ConversationItemBody.notice,
      value: { kind: 'model_change', label: 'Claude Code', model: 'opus' },
    },
    {
      name: 'a message with a mention of a path with spaces',
      schema: PostConversationMessage,
      value: { text: '@docs/a b.md', mentions: ['docs/a b.md'] },
    },
  ])('$name parses and round-trips', ({ schema, value }) => {
    const parsed = schema.safeParse(value);
    expect(parsed.success).toBe(true);
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it.each<{
    name: string;
    schema: { safeParse(v: unknown): { success: boolean } };
    value: unknown;
  }>([
    {
      name: 'a create with a title key',
      schema: ChatCreateInput,
      value: { projectId: mintId('Project'), model: null, tabPosition: 0, title: 'x' },
    },
    { name: 'an empty patch', schema: ChatPatchInput, value: {} },
    {
      name: 'a mention of ../x',
      schema: PostConversationMessage,
      value: { text: 'x', mentions: ['../x'] },
    },
    {
      name: 'a mention of /etc/passwd',
      schema: PostConversationMessage,
      value: { text: 'x', mentions: ['/etc/passwd'] },
    },
    {
      name: 'set_title with an empty title',
      schema: ChatToolInputs.set_title,
      value: { title: '' },
    },
    {
      name: 'a model_change notice with no model',
      schema: ConversationItemBody.notice,
      value: { kind: 'model_change' },
    },
    {
      name: 'a files query with a root',
      schema: ConversationFilesQuery,
      value: { q: 'a', root: '/x' },
    },
    { name: 'a chat whose id is not a chat id', schema: ChatDto, value: { ...chat, id: 'shp_x' } },
  ])('$name is refused', ({ schema, value }) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('a message with no mentions reads as none', () => {
    expect(PostConversationMessage.parse({ text: 'hi' }).mentions).toEqual([]);
  });
});

describe('cutTitle', () => {
  it.each([
    { name: 'a short title stays', title: 'Retry login on a 401', cut: 'Retry login on a 401' },
    {
      name: 'a long one is cut at a word',
      title: 'Retry login once on a 401 after the token refresh',
      cut: 'Retry login once on a 401',
    },
    { name: 'a trailing period goes', title: 'Fix it.', cut: 'Fix it' },
    { name: 'one long word is cut at the cap', title: 'a'.repeat(40), cut: 'a'.repeat(28) },
  ])('$name', ({ title, cut }) => {
    expect(cutTitle(title)).toBe(cut);
  });
});
