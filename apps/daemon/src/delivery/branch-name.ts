import type { BatchId } from '@10db/contracts';

export const BRANCH_PREFIX = '10db/';
export const MAX_SLUG = 40;
const ID_SUFFIX = 8;

/**
 * `text` as a slug of ASCII letters and digits joined by single dashes, cut to MAX_SLUG at a word
 * boundary; `fallback` when nothing is left. It can't hold an option, a ref expression, a path
 * separator or shell text.
 */
export function slugOf(text: string, fallback: string): string {
  const slug = text
    .normalize('NFKD')
    // Drop the combining marks NFKD split off (`Ü` → `U`); \p{M} stays readable where a range of
    // literal combining characters would not.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return capSlug(slug) || fallback;
}

/** `10db/<slug>-<last 8 hex of the batch id>` (batch delivery spec §5). */
export function batchBranchName(title: string, id: BatchId): string {
  return `${BRANCH_PREFIX}${slugOf(title, 'batch')}-${id.slice(-ID_SUFFIX)}`;
}

/**
 * Cuts a dash-separated slug to MAX_SLUG at a word boundary. The window's last dash is the
 * nearest boundary the cap allows, so a word that ends exactly at the cap is kept whole. A first
 * word longer than the cap has no such dash, so it is cut to the cap.
 */
function capSlug(slug: string): string {
  if (slug.length <= MAX_SLUG) return slug;
  const boundary = slug.slice(0, MAX_SLUG + 1).lastIndexOf('-');
  return boundary > 0 ? slug.slice(0, boundary) : slug.slice(0, MAX_SLUG);
}
