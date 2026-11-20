import type { ShapeId } from '@10db/contracts';
import { listShapeLinks, listShapeProposals, type DbReader, type ShapeProposalRow } from '@10db/db';
import { convertedStateLines } from './converted-state';
import { missizedLines } from './sizing';

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
 * What a fresh session is told of the plan, after the chat's own digest: the current proposals with where
 * each came from, and what Accept made. Built from the rows alone, so the same plan always gives the same
 * digest and what the new session saw is on record.
 */
export function buildDigest(db: DbReader, shapeId: ShapeId): string {
  const rows = listShapeProposals(db, shapeId);
  const links = listShapeLinks(db, shapeId);
  const lines: string[] = ['The plan, as it stands:'];
  if (rows.length === 0) lines.push('Nothing is proposed yet.');
  for (const row of rows)
    lines.push(
      `- ${row.key} (${row.kind}, ${row.state}, round ${String(row.round)}; sources ${row.sourceMessageIds.join(', ') || 'none'}): ${titleOf(row)}`,
    );
  if (links.length > 0) {
    lines.push('', 'What Accept made, as it stands now:', ...convertedStateLines(db, shapeId));
    const missized = missizedLines(db, shapeId);
    if (missized.length > 0) lines.push('', ...missized);
  }
  return lines.join('\n');
}
