import type { ContextPack } from '@10db/contracts';
import { quotedWords } from '../knowledge';

type PendingAnswer = ContextPack['pendingAnswer'];

/**
 * The answer a lane fetches with get_context: what a stakeholder wrote in Slack (the note, the words, and each
 * message and name of the conversation) is quoted data, so it cannot read as an instruction. An answer the
 * builder gave is returned as it is.
 */
export function quoteSlackAnswer(pending: PendingAnswer): PendingAnswer {
  if (pending?.via !== 'slack') return pending;
  return {
    ...pending,
    note: pending.note === null ? null : quotedWords(pending.note),
    words: pending.words === null ? null : quotedWords(pending.words),
    conversation: pending.conversation.map((m) => ({
      name: quotedWords(m.name, 200),
      text: quotedWords(m.text),
    })),
  };
}
