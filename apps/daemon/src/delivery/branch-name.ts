import type { BatchId } from '@10db/contracts';

export const BRANCH_PREFIX = '10db/';
export const MAX_SLUG = 40;
const ID_SUFFIX = 8;

/**
 * `10db/<slug>-<last 8 hex of the batch id>` (batch delivery spec §5). The slug keeps ASCII letters
 * and digits only, so a title can't put an option, a ref expression or shell text into the name.
 */
export function batchBranchName(title: string, id: BatchId): string {
  const slug = title
    .normalize('NFKD')
    // Drop the combining marks NFKD split off (`Ü` → `U`); \p{M} stays readable where a range of
    // literal combining characters would not.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return `${BRANCH_PREFIX}${slug === '' ? 'batch' : slug}-${id.slice(-ID_SUFFIX)}`;
}
