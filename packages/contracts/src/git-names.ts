import { z } from 'zod';

/**
 * A branch name 10db hands to git and gh as an argument: never an option (no leading `-`), never a
 * ref expression (`..`, `@{`), and within git's own rules for a ref name.
 */
export const BranchName = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    'letters, digits, ".", "_", "/" and "-", starting with a letter or digit',
  )
  .refine(
    (b) =>
      !b.includes('..') &&
      !b.includes('//') &&
      !b.endsWith('/') &&
      !b.endsWith('.') &&
      !b.endsWith('.lock'),
    'not a valid git branch name',
  );

/** A Conventional Commit type with an optional scope and `!`; the PR title is `<prefix>: <batch title>`. */
export const PrTitlePrefix = z
  .string()
  .regex(
    /^[a-z]+(\([a-z0-9][a-z0-9._/-]*\))?!?$/,
    'a Conventional Commit type and scope, such as feat(daemon)',
  );

/** What every branch 10db makes for a batch starts with. */
export const BRANCH_PREFIX = '10db/';
const MAX_SLUG = 40;

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

/** A batch branch's name up to the short id added when the branch is cut: `10db/<slug>`. */
export function batchBranchStem(title: string): string {
  return `${BRANCH_PREFIX}${slugOf(title, 'batch')}`;
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
