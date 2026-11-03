import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * What ties an Allow Edit card to the write its own call made, so the watcher excuses that write and no other:
 * in a checkout several lanes share it cannot tell who wrote a file, but it can tell whether the file is
 * exactly what the allowed call produced.
 *
 * - `exactWrite: true` is set on every edit card the broker raises. Such a card excuses only a file whose
 *   content hash is the one recorded for the lane, and nothing when none was recorded.
 * - `allowedWrites` maps each lane the card allowed to the SHA-256 of the file its call produces. The broker
 *   records it when it lets the call through: it reads the file and applies the call as Claude Code does. One
 *   entry per lane, so a card folded from several lanes' calls keeps each lane's own.
 * A card without `exactWrite` (raised before this was kept) excuses the next write to its file, as it did.
 */
export const EXACT_WRITE_KEY = 'exactWrite';
export const ALLOWED_WRITES_KEY = 'allowedWrites';
/**
 * `escalated: true` marks a card raised for a call Claude Code's classifier handed to a person. No stored
 * rule answers such a call, so a project rule allowed on another lane's card does not release it either.
 */
export const ESCALATED_KEY = 'escalated';

const SHA256 = /^[0-9a-f]{64}$/;

const sha256 = (text: string): string =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const stringIn = (input: Record<string, unknown>, key: string): string | null => {
  const value = input[key];
  return typeof value === 'string' ? value : null;
};

/**
 * Claude Code's `stripTrailingWhitespace`: every line of `new_string` loses the whitespace at its end
 * (`trimEnd`, so a no-break space too), the line separators (LF, CRLF, CR) staying as they are.
 */
function stripTrailingWhitespace(text: string): string {
  return text
    .split(/(\r\n|\n|\r)/)
    .map((part, index) => (index % 2 === 0 ? part.trimEnd() : part))
    .join('');
}

/** Markdown keeps its trailing whitespace (two spaces are a line break); Claude Code tells it by extension. */
const isMarkdown = (path: string | null): boolean => path !== null && /\.(md|mdx)$/i.test(path);

/**
 * One `old_string` → `new_string` edit applied to `current` as Claude Code applies it; undefined when it fails.
 * `path` is the edited file's `file_path`, which decides whether `new_string` loses its trailing whitespace.
 */
function applyEdit(current: string | null, edit: unknown, path: string | null): string | undefined {
  if (typeof edit !== 'object' || edit === null) return undefined;
  const fields = edit as Record<string, unknown>;
  const oldText = stringIn(fields, 'old_string');
  const rawNewText = stringIn(fields, 'new_string');
  if (oldText === null || rawNewText === null) return undefined;
  const newText = isMarkdown(path) ? rawNewText : stripTrailingWhitespace(rawNewText);
  // An empty old_string creates the file, or fills one that is empty; on a file with content it fails.
  if (oldText === '') return current === null || current === '' ? newText : undefined;
  if (current === null) return undefined;
  const at = current.indexOf(oldText);
  if (at < 0) return undefined;
  const replaceAll = fields['replace_all'] === true;
  // Without replace_all an old_string found more than once is refused, and nothing is written. Claude Code
  // counts with split, so matches that overlap ('==' in 'a === b') are one match, not two.
  if (!replaceAll && current.split(oldText).length - 1 > 1) return undefined;
  // A deletion takes the newline after its text with it, where one follows (Claude Code's applyEditToFile).
  const search =
    newText === '' && !oldText.endsWith('\n') && current.includes(`${oldText}\n`)
      ? `${oldText}\n`
      : oldText;
  if (replaceAll) return current.split(search).join(newText);
  const from = current.indexOf(search);
  return current.slice(0, from) + newText + current.slice(from + search.length);
}

/**
 * The content the call `toolName(input)` leaves in a file that held `current` (null: no such file), or
 * undefined when it can't be told: a NotebookEdit, a malformed call, or an edit that would fail.
 */
export function editResult(
  toolName: string,
  input: Record<string, unknown>,
  current: string | null,
): string | undefined {
  if (toolName === 'Write') return stringIn(input, 'content') ?? undefined;
  if (toolName !== 'Edit' && toolName !== 'MultiEdit') return undefined;
  // Claude Code reads the file with its line endings as LF, edits that, and writes it back in the file's own
  // endings: CRLF when the start of the file has more CRLF than bare LF.
  const crlf = current !== null && usesCrlf(current);
  const lf = current === null ? null : current.replaceAll('\r\n', '\n');
  const path = stringIn(input, 'file_path');
  let content: string | undefined;
  if (toolName === 'Edit') {
    content = applyEdit(lf, input, path);
  } else {
    if (!Array.isArray(input['edits'])) return undefined;
    let next: string | null = lf;
    for (const edit of input['edits'] as unknown[]) {
      const applied = applyEdit(next, edit, path);
      if (applied === undefined) return undefined;
      next = applied;
    }
    content = next ?? undefined;
  }
  if (content === undefined) return undefined;
  return crlf ? content.replaceAll('\n', '\r\n') : content;
}

/** Claude Code's line-ending check: CRLF outnumbering bare LF in the first 4096 characters. */
function usesCrlf(text: string): boolean {
  const head = text.slice(0, 4096);
  const crlf = head.split('\r\n').length - 1;
  const lf = head.split('\n').length - 1 - crlf;
  return crlf > lf;
}

/**
 * The SHA-256 of what the call leaves at `path`, from the file as it is now; undefined when it can't be told
 * (see `editResult`, or a path that is not absolute or can't be read).
 */
export function allowedWriteHash(
  toolName: string,
  input: Record<string, unknown>,
  path: string,
): string | undefined {
  if (!isAbsolute(path)) return undefined;
  let current: string | null;
  try {
    current = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    current = null;
  }
  const result = editResult(toolName, input, current);
  return result === undefined ? undefined : sha256(result);
}

/** The lane → hash entries a card's detail records, the well-formed ones only. */
export function allowedWritesIn(detail: Record<string, unknown> | null): Record<string, string> {
  const raw = detail?.[ALLOWED_WRITES_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && SHA256.test(entry[1]),
    ),
  );
}

/**
 * What a card excuses for `lane`'s write: the file hash its allowed call produces, null when the card asks
 * for that exact write but none was recorded (it excuses nothing), undefined for a card from before.
 */
export function allowedWriteFor(
  detail: Record<string, unknown> | null,
  lane: string,
): string | null | undefined {
  if (detail?.[EXACT_WRITE_KEY] !== true) return undefined;
  return allowedWritesIn(detail)[lane] ?? null;
}
