import {
  InboxState,
  SendState,
  type InboxItemId,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';

/** A question that is out with someone: sent, not yet answered, and not returned to the builder. */
export interface SentCard {
  readonly inboxItemId: InboxItemId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** The workstreams whose run asked it. */
  readonly workstreamIds: readonly WorkstreamId[];
  /** The people it is waiting on, in routing order. */
  readonly names: readonly string[];
  /** When the wait started: the send, or the builder's last Keep Waiting. */
  readonly since: string;
  readonly assigneeIds: readonly string[];
}

/**
 * The open question cards that wait on other people. A card that came back (its timer ran out, or its
 * recipients disagree) is the builder's again and is not listed, so a line saying "waiting on Mark" never
 * contradicts the Inbox's Open tab.
 */
export function sentCards(db: DbReader, projectId?: ProjectId): SentCard[] {
  const sends = db
    .select({ send: schema.stakeholderSends, card: schema.inboxItems })
    .from(schema.stakeholderSends)
    .innerJoin(schema.inboxItems, eq(schema.inboxItems.id, schema.stakeholderSends.inboxItemId))
    .where(
      and(
        eq(schema.stakeholderSends.state, SendState.Sent),
        isNull(schema.stakeholderSends.returnedAt),
        eq(schema.inboxItems.state, InboxState.Open),
        ...(projectId === undefined ? [] : [eq(schema.inboxItems.projectId, projectId)]),
      ),
    )
    .orderBy(asc(schema.stakeholderSends.createdAt))
    .all();
  return sends.map(({ send, card }) => {
    const people = db
      .select()
      .from(schema.stakeholderSendPeople)
      .where(
        and(
          eq(schema.stakeholderSendPeople.sendId, send.id),
          eq(schema.stakeholderSendPeople.recipient, true),
        ),
      )
      .orderBy(asc(schema.stakeholderSendPeople.position))
      .all();
    return {
      inboxItemId: card.id,
      projectId: card.projectId,
      title: card.title,
      workstreamIds: card.targets.map((t) => t.workstreamId),
      names: people.map((p) => p.name),
      since: send.waitStartedAt ?? send.sentAt ?? send.createdAt,
      assigneeIds: people.flatMap((p) => (p.personId === null ? [] : [p.personId])),
    };
  });
}
