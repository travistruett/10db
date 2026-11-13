import { listAttachmentRevisions, listAttachmentsOfKinds } from '@10db/db';
import type { StateStore } from '../events';
import { appendRevision } from './revisions';

/**
 * Gives every spec and eval kept before revisions existed its revision 1, from its body. Runs at
 * start; a second run finds nothing to do. Answers how many it gave.
 */
export function backfillAttachmentRevisions(state: StateStore): number {
  const bare = listAttachmentsOfKinds(state.db, ['spec', 'eval']).filter(
    (row) => listAttachmentRevisions(state.db, row.id).length === 0,
  );
  if (bare.length === 0) return 0;
  state.write((ctx) => {
    for (const row of bare)
      appendRevision(ctx, row.id, row.body, {
        note: 'kept before revisions',
        author: '10db',
        bundleNumber: null,
        authoredAt: null,
      });
  });
  return bare.length;
}
