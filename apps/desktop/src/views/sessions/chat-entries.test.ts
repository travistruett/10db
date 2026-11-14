import { mintId, type ChatToolResult } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { ConversationEntry } from '../../conversation';
import { commandCall, mcpCall, toolEntry } from '../../test/tool-call-fixtures';
import { chatEntries, chatToolResult } from './chat-entries';

// A chat's builder tools become rows with Undo, and nothing else changes.

const taskId = mintId('Task');
const context = { chatId: mintId('Chat'), projectId: mintId('Project') };

const result = (r: ChatToolResult): string => JSON.stringify(r);
const call = (tool: string, resultTail: string | null, server = '10db') =>
  mcpCall({ id: tool, harnessTool: `mcp__${server}__${tool}`, server, tool, resultTail });

describe('chatToolResult', () => {
  it.each<[string, ReturnType<typeof call>, ChatToolResult['kind'] | null]>([
    [
      'create_task with a task result',
      call('create_task', result({ kind: 'task', taskId, title: 'Retry', column: 'Ready' })),
      'task',
    ],
    ['create_task with an unparseable result', call('create_task', 'Created it.'), null],
    ['create_task with no result yet', call('create_task', null), null],
    [
      'edit_task with a task_edit result',
      call(
        'edit_task',
        result({ kind: 'task_edit', taskId, title: 'Retry', previous: { title: 'Old' } }),
      ),
      'task_edit',
    ],
    [
      'edit_task whose result is a create’s is never a create row',
      call('edit_task', result({ kind: 'task', taskId, title: 'Retry', column: 'Ready' })),
      null,
    ],
    [
      'start_task with a start result',
      call('start_task', result({ kind: 'start', taskId, started: true })),
      'start',
    ],
    [
      'set_title with a title result',
      call('set_title', result({ kind: 'title', title: 'New', previousTitle: 'Old' })),
      'title',
    ],
    [
      'another server’s create_task',
      call('create_task', result({ kind: 'task', taskId, title: 'x', column: 'Ready' }), 'github'),
      null,
    ],
    ['a read tool', call('list_tasks', '[]'), null],
  ])('%s', (_name, c, kind) => {
    expect(chatToolResult(c)?.kind ?? null).toBe(kind);
  });
});

describe('chatEntries', () => {
  it('turns a drawn call into a custom row and leaves every other entry as it was', () => {
    const drawn = toolEntry(
      call('create_task', result({ kind: 'task', taskId, title: 'Retry', column: 'Ready' })),
    );
    const plain = toolEntry(commandCall());
    const reply: ConversationEntry = { kind: 'reply', id: 'r', text: 'Done', partial: false };
    const out = chatEntries([reply, drawn, plain], context);
    expect(out.map((e) => e.kind)).toEqual(['reply', 'custom', 'tool']);
    expect(out[1]?.id).toBe(drawn.id);
    expect(out[2]).toBe(plain);
  });
});
