import { ChatToolName, ChatToolResult, type ToolCallView } from '@10db/contracts';
import { createElement } from 'react';
import type { ConversationEntry } from '../../conversation';
import { TaskRow, type TaskRowContext } from './task-row';

// A chat's builder tools (plan call 2) come back as `mcp` calls on 10db's own server. A call whose result
// reads as what the tool should return is a row of its own, with Undo; any other stays the kit's tool row.

/** 10db's own server, as the adapters name it. */
const TENDB_SERVER = '10db';

/** The result each drawn tool must return; a call whose result is another kind stays a plain row. */
const RESULT_OF_TOOL: Readonly<Partial<Record<string, ChatToolResult['kind']>>> = {
  [ChatToolName.CreateTask]: 'task',
  [ChatToolName.EditTask]: 'task_edit',
  [ChatToolName.StartTask]: 'start',
  [ChatToolName.SetTitle]: 'title',
};

/** The result a chat tool call carries, or null when it is not one, or its result does not parse. */
export function chatToolResult(call: ToolCallView): ChatToolResult | null {
  if (call.kind !== 'mcp' || call.server !== TENDB_SERVER || call.resultTail === null) return null;
  const wanted = RESULT_OF_TOOL[call.tool];
  if (wanted === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(call.resultTail);
  } catch {
    return null;
  }
  const result = ChatToolResult.safeParse(json);
  return result.success && result.data.kind === wanted ? result.data : null;
}

/** The entries with each chat tool call that has a drawn result turned into its own row. */
export function chatEntries(
  entries: readonly ConversationEntry[],
  context: TaskRowContext,
): readonly ConversationEntry[] {
  return entries.map((entry): ConversationEntry => {
    if (entry.kind !== 'tool') return entry;
    const result = chatToolResult(entry.call);
    if (result === null) return entry;
    return {
      kind: 'custom',
      id: entry.id,
      render: () => createElement(TaskRow, { rowId: entry.id, result, context }),
    };
  });
}
