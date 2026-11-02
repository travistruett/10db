import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * What the edit call behind an Allow Edit card writes, kept on the card so the watcher excuses the write the
 * builder approved and no other: in a checkout several lanes share, it cannot tell who wrote a file, but it
 * can tell whether the file holds what this call put there.
 *
 * - `sha256`: the file's whole content, for a Write.
 * - `contains`: the text an Edit or MultiEdit puts in (each `new_string`), for a file the call changes in
 *   part; the rest of the file is whatever it already held.
 * A card with neither (a NotebookEdit, a call whose text is empty or too large to keep, a card from before
 * this was kept) excuses the next write to its file, as it always did.
 */
export const ExpectedWrite = z.union([
  z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({ contains: z.array(z.string().min(1)).min(1) }).strict(),
]);
export type ExpectedWrite = z.infer<typeof ExpectedWrite>;

/** The most text an Edit's card keeps for the watcher to look for; a larger one keeps none. */
const MAX_CONTAINS_BYTES = 256 * 1024;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const stringIn = (input: Record<string, unknown>, key: string): string | null => {
  const value = input[key];
  return typeof value === 'string' ? value : null;
};

/** What the call `toolName(input)` will write, or undefined when it can't be told from the call. */
export function expectedWriteOf(
  toolName: string,
  input: Record<string, unknown>,
): ExpectedWrite | undefined {
  if (toolName === 'Write') {
    const content = stringIn(input, 'content');
    return content === null ? undefined : { sha256: sha256(content) };
  }
  let parts: unknown[];
  if (toolName === 'Edit') parts = [input['new_string']];
  else if (toolName === 'MultiEdit' && Array.isArray(input['edits'])) {
    parts = (input['edits'] as unknown[]).map((edit) =>
      typeof edit === 'object' && edit !== null
        ? (edit as Record<string, unknown>)['new_string']
        : null,
    );
  } else return undefined;
  // A part that deletes text puts none in; a part that is no text is one the card can't name.
  if (!parts.every((p) => typeof p === 'string')) return undefined;
  const texts = parts.filter((p) => p !== '');
  if (texts.length === 0) return undefined;
  if (texts.reduce((n, t) => n + Buffer.byteLength(t), 0) > MAX_CONTAINS_BYTES) return undefined;
  return { contains: [...new Set(texts)] };
}

/** The `expectedWrite` a card's detail carries, if it carries a well-formed one. */
export function expectedWriteIn(detail: Record<string, unknown> | null): ExpectedWrite | undefined {
  const parsed = ExpectedWrite.safeParse(detail?.['expectedWrite']);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Whether the file now holding `content` (its SHA-256 `hash`) is what `expected` says its call wrote.
 * `content` is read lazily, as only a `contains` expectation needs it.
 */
export function matchesExpectedWrite(
  expected: ExpectedWrite,
  hash: string,
  content: () => string | null,
): boolean {
  if ('sha256' in expected) return expected.sha256 === hash;
  const text = content();
  return text !== null && expected.contains.every((part) => text.includes(part));
}
