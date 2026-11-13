import type { SessionEvent } from './types';

/** The events a session streams as it works, which are logged and read by no view yet. */
export type StreamEvent = Extract<
  SessionEvent,
  { type: 'text_delta' | 'reasoning_delta' | 'message' | 'tool_call' | 'commands' | 'plan_update' }
>;

/** A stream event's log fields: ids and sizes, never the agent's text. */
export function streamEventLogFields(
  event: StreamEvent,
): Readonly<Record<string, string | number>> {
  switch (event.type) {
    case 'text_delta':
    case 'reasoning_delta':
      return {
        type: event.type,
        itemId: event.itemId,
        offset: event.offset,
        chars: event.text.length,
      };
    case 'message':
      return { type: event.type, itemId: event.itemId, chars: event.text.length };
    case 'tool_call':
      return {
        type: event.type,
        callId: event.call.id,
        kind: event.call.kind,
        status: event.call.status,
      };
    case 'commands':
      return { type: event.type, count: event.commands.length };
    case 'plan_update':
      return { type: event.type, count: event.steps.length };
  }
}
