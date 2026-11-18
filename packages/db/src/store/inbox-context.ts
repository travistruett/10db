import {
  ConversationId,
  ConversationItemBody,
  ConversationItemKind,
  ConversationOwnerKind,
  type InboxCardContextDto,
  type InboxItemId,
} from '@10db/contracts';
import { desc, inArray, eq, and } from 'drizzle-orm';
import * as schema from '../schema';
import { conversationOf } from './conversations';
import { getInboxItem } from './inbox';
import type { DbReader } from './store';
import { getWorkstream } from './workstreams';

/** The conversation a card speaks from: the one its detail names, else its lane's task's. */
function conversationFor(db: DbReader, id: InboxItemId): ConversationId | null {
  const card = getInboxItem(db, id);
  const named = ConversationId.safeParse(card.detail?.['conversationId']);
  if (named.success) {
    const row = db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, named.data))
      .get();
    if (row) return row.id;
  }
  const target = card.targets[0];
  if (target === undefined) return null;
  const owner = {
    kind: ConversationOwnerKind.Task,
    id: getWorkstream(db, target.workstreamId).taskId,
  };
  return conversationOf(db, owner)?.id ?? null;
}

/**
 * The card's conversation's newest `count` messages, builder's and agent's only, oldest first. A tool
 * call or reasoning is not what a question needs beside it.
 */
export function inboxCardContext(
  db: DbReader,
  id: InboxItemId,
  count: number,
): InboxCardContextDto {
  const conversationId = conversationFor(db, id);
  if (conversationId === null) return { messages: [] };
  const rows = db
    .select()
    .from(schema.conversationItems)
    .where(
      and(
        eq(schema.conversationItems.conversationId, conversationId),
        inArray(schema.conversationItems.kind, [
          ConversationItemKind.Message,
          ConversationItemKind.AgentMessage,
        ]),
      ),
    )
    .orderBy(desc(schema.conversationItems.seq))
    .limit(count)
    .all()
    .reverse();
  const messages: InboxCardContextDto['messages'] = [];
  for (const row of rows) {
    const kind = row.kind === ConversationItemKind.Message ? 'message' : 'agent_message';
    const body = ConversationItemBody[kind].safeParse(row.body);
    if (!body.success) continue;
    messages.push({
      author: kind === 'message' ? 'builder' : 'agent',
      text: body.data.text,
      at: row.createdAt,
    });
  }
  return { messages };
}
