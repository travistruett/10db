import { SendState } from '@10db/contracts';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema';

const items = schema.inboxItems;
const sends = schema.stakeholderSends;

/** A card has at most one send in these states: the one it shows. */
export const LIVE_SEND_STATES = [SendState.Draft, SendState.Sending, SendState.Sent];

/** The send is out with someone: sent, and not brought back by a timer or a disagreement. */
export const sendIsOut = and(eq(sends.state, SendState.Sent), isNull(sends.returnedAt));

/** When the card's live send went out; null for a card with none. */
export const SENT_AT = sql`(SELECT ${sends.sentAt} FROM ${sends}
  WHERE ${sends.inboxItemId} = ${items.id} AND ${inArray(sends.state, LIVE_SEND_STATES)})`;

/** Title or body contains `text`; SQLite's `LIKE` folds ASCII case only, and `%`, `_` and `\` match themselves. */
export function textMatches(text: string): SQL {
  const pattern = `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return sql`(${items.title} LIKE ${pattern} ESCAPE '\\' OR ${items.body} LIKE ${pattern} ESCAPE '\\')`;
}
