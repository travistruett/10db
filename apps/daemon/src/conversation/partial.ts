import {
  ConversationItemAuthor,
  ConversationItemKind,
  ToolCallStatus,
  type ConversationId,
  type ConversationItemId,
  type LiveItemDto,
  type ToolCallView,
} from '@10db/contracts';
import { putItem, type WriteContext } from '@10db/db';

// Sessions spec §6.3. When a turn ends early (a stop, an error, a cut-off), what it streamed is kept:
// each text marked partial, and a call still running read as failed, each under its live id.

export interface PartialItem {
  readonly id: ConversationItemId;
  readonly author: typeof ConversationItemAuthor.Agent;
  readonly kind:
    | typeof ConversationItemKind.AgentMessage
    | typeof ConversationItemKind.Reasoning
    | typeof ConversationItemKind.ToolCall;
  readonly body: ToolCallView | { readonly text: string };
  readonly partial: true;
}

/** A running call, ended early: failed, with the output it had. */
function endedCall(call: ToolCallView, output: string): ToolCallView {
  const status = call.status === ToolCallStatus.Running ? ToolCallStatus.Failed : call.status;
  return call.kind === 'command' ? { ...call, status, outputTail: output } : { ...call, status };
}

/** What an early end stores of the items in flight; an empty text stores nothing. Pure. */
export function partialItems(inFlight: readonly LiveItemDto[]): readonly PartialItem[] {
  return inFlight.flatMap((item): PartialItem[] => {
    if (item.kind === 'tool_call')
      return [
        {
          id: item.itemId,
          author: ConversationItemAuthor.Agent,
          kind: ConversationItemKind.ToolCall,
          body: endedCall(item.call, item.output),
          partial: true,
        },
      ];
    if (item.text === '') return [];
    return [
      {
        id: item.itemId,
        author: ConversationItemAuthor.Agent,
        kind: item.kind,
        body: { text: item.text },
        partial: true,
      },
    ];
  });
}

/** Stores what an early end keeps, in the caller's write; answers the ids, each its live one. */
export function storePartial(
  ctx: WriteContext,
  conversationId: ConversationId,
  inFlight: readonly LiveItemDto[],
): ConversationItemId[] {
  return partialItems(inFlight).map(
    (item) => putItem(ctx, conversationId, { ...item, body: { ...item.body } }).id,
  );
}
