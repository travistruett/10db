import { createHash } from 'node:crypto';
import type { ShapeAttachmentId } from '@10db/contracts';
import {
  getDocumentAttachment,
  insertAttachmentRevision,
  type AttachmentRevisionRow,
  type WriteContext,
} from '@10db/db';
import { indexSections } from './sections';

/** Hex SHA-256 of a text's UTF-8 bytes. */
export const sha256Of = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Appends a revision to a document, an app spec or an eval, with its hash and its sections (an eval is
 * JSON and has none). The same text again without a bundle number writes nothing.
 */
export function appendRevision(
  ctx: WriteContext,
  attachmentId: ShapeAttachmentId,
  body: string,
  meta: {
    readonly note: string | null;
    readonly author: string | null;
    readonly bundleNumber: number | null;
    readonly authoredAt: string | null;
  },
): { row: AttachmentRevisionRow; created: boolean } {
  const attachment = getDocumentAttachment(ctx.tx, attachmentId);
  return insertAttachmentRevision(ctx, {
    attachmentId,
    body,
    sha256: sha256Of(body),
    sections: attachment?.kind === 'eval' ? [] : indexSections(body),
    ...meta,
  });
}
