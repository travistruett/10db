import type { AnchorCheckDto } from '@10db/contracts';
import type { AnchorCheckRow } from '@10db/db';

/** A stored anchor check as the brief, the lane tools and the Record view show it. */
export const anchorCheckDto = (row: AnchorCheckRow): AnchorCheckDto => ({
  entryKey: row.entryKey,
  entryVersion: row.entryVersion,
  anchorIndex: row.anchorIndex,
  result: row.result,
  line: row.line,
  checkedCommit: row.checkedCommit,
  note: row.note,
  workstreamId: row.workstreamId,
  at: row.createdAt,
});
