import { join } from 'node:path';
import type { GuardrailDiffDetail } from '@10db/contracts';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import type { Git } from '../git';
import { readSmallFile } from './trusted-writes';

/** A card shows at most this many lines of a diff; the rest is cut and the card says so. */
const GUARDRAIL_DIFF_MAX_LINES = 200;
/** And at most this many characters, since a few lines can be very long. */
const MAX_DIFF_CHARS = 32 * 1024;
/** A file bigger than this is not read for a diff. */
const MAX_DIFF_FILE_BYTES = 1024 * 1024;

/** A file's diff as the card carries it, and whether git holds the file at `HEAD`. */
export interface GuardrailDiff {
  readonly detail: GuardrailDiffDetail;
  readonly tracked: boolean;
}

const none = (reason: string, tracked: boolean): GuardrailDiff => ({
  detail: { shown: 'none', reason },
  tracked,
});

/** The first `GUARDRAIL_DIFF_MAX_LINES` lines of `text` (and `MAX_DIFF_CHARS` characters), and whether it was cut. */
function capped(text: string): { text: string; cut: boolean; lines: number } {
  const lines = text.replace(/\n$/, '').split('\n');
  const kept = lines.slice(0, GUARDRAIL_DIFF_MAX_LINES);
  const joined = kept.join('\n');
  const cutLines = kept.length < lines.length;
  if (joined.length <= MAX_DIFF_CHARS) return { text: joined, cut: cutLines, lines: kept.length };
  const short = joined.slice(0, MAX_DIFF_CHARS);
  return { text: short, cut: true, lines: short.split('\n').length };
}

/** A patch of several files as the card carries it, cut to the same cap as one file's. */
export function guardrailPatchDetail(patch: string): GuardrailDiffDetail {
  return { shown: 'text', ...capped(patch), isNew: false };
}

/** The card's words for a diff that is not shown, and why. */
export function guardrailNoDiffDetail(reason: string): GuardrailDiffDetail {
  return { shown: 'none', reason };
}

/**
 * The file's diff against `HEAD` in the checkout `root`, or its whole text marked as new when git does not hold
 * it, cut to a cap. A file that is not text (binary, a link, too big) says so instead of a diff. The working
 * file is read without following a link, and `HEAD` from git's object store.
 */
export async function guardrailDiffOf(git: Git, root: string, rel: string): Promise<GuardrailDiff> {
  let committed;
  try {
    committed = await git.fileAt(root, 'HEAD', rel, MAX_DIFF_FILE_BYTES);
  } catch {
    return none('git could not read the committed file', true);
  }
  const tracked = committed.kind !== 'missing';
  if (committed.kind === 'not_regular')
    return none('the committed file is not a regular file', tracked);
  if (committed.kind === 'too_large') return none('the committed file is too big to show', tracked);
  const read = readSmallFile(join(root, rel), MAX_DIFF_FILE_BYTES);
  if (read.kind !== 'file')
    return none('the file is not a regular file, or is too big to show', tracked);
  if (read.bytes.includes(0)) return none('the file is binary', tracked);
  const before = committed.kind === 'file' ? committed.text : '';
  const after = read.bytes.toString('utf8');
  if (tracked && before === after)
    return none('the content is the same as the committed file', tracked);
  const patch = createTwoFilesPatch(
    tracked ? `a/${rel}` : '/dev/null',
    `b/${rel}`,
    before,
    after,
    undefined,
    undefined,
    { headerOptions: FILE_HEADERS_ONLY },
  );
  return { detail: { shown: 'text', ...capped(patch), isNew: !tracked }, tracked };
}
