import { ShapeMessageAuthor, type ShapeId } from '@10db/contracts';
import {
  lastShapeMessages,
  listShapeLinks,
  listShapeProposals,
  type DbReader,
  type ShapeProposalRow,
} from '@10db/db';

/** How many of the latest transcript rows the digest repeats verbatim (Shape spec §5.3). */
export const DIGEST_MESSAGES = 40;

/** The row's title as the sidebar shows it. */
function titleOf(row: ShapeProposalRow): string {
  const body: unknown = row.body;
  if (typeof body === 'object' && body !== null) {
    for (const field of ['title', 'question', 'statement', 'text', 'why']) {
      const value: unknown = Reflect.get(body, field);
      if (typeof value === 'string') return value;
    }
  }
  return row.key;
}

/**
 * What a fresh SDK session is told when the old one is gone or full: the latest messages as they
 * were said, the current proposals with where each came from, and what Convert made. Built from the
 * rows alone, so the same conversation always gives the same digest and what the new session saw is
 * on record. A builder message keeps its id, so the new session can cite it.
 */
export function buildDigest(db: DbReader, shapeId: ShapeId): string {
  const messages = lastShapeMessages(db, shapeId, DIGEST_MESSAGES);
  const rows = listShapeProposals(db, shapeId);
  const links = listShapeLinks(db, shapeId);
  const lines: string[] = [
    'This conversation continues in a fresh session. Nothing is lost: here is where it stands.',
    '',
    `The last ${String(messages.length)} messages, as they were said:`,
  ];
  for (const m of messages) {
    const speaker = m.author === ShapeMessageAuthor.Builder ? `[m:${m.id}]` : `(${m.author})`;
    lines.push(`${speaker} ${m.body}`);
  }
  lines.push('', 'The proposals:');
  if (rows.length === 0) lines.push('Nothing is proposed yet.');
  for (const row of rows)
    lines.push(
      `- ${row.key} (${row.kind}, ${row.state}, round ${String(row.round)}; sources ${row.sourceMessageIds.join(', ') || 'none'}): ${titleOf(row)}`,
    );
  if (links.length > 0) {
    lines.push('', 'What Convert made:');
    for (const link of links) {
      const target =
        link.goalId !== null
          ? `goal ${link.goalId}`
          : link.taskId !== null
            ? `task ${link.taskId}`
            : `decision ${link.decisionId ?? ''}`;
      lines.push(`- ${link.key} → ${target}`);
    }
  }
  return lines.join('\n');
}
