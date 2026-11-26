import { LinearPostId } from '@10db/contracts';

// The comment 10db writes for an owed update, built only from the agent's words. The agent hands over a body;
// 10db cleans it, adds the footer, and is the only author of the text Linear receives.

/** A body shorter than this says nothing a reader can use; the agent reports "nothing to report" instead. */
export const MIN_BODY_CHARS = 20;

/**
 * The footer an update's comment ends with: the event and the attempt, which is what tells one update of a run
 * from another. The row's own id stays in 10db; a reader of Linear has no use for it.
 */
export const footerOf = (p: { readonly event: string; readonly attempt: number }): string =>
  `10db · ${p.event} · attempt ${String(p.attempt)}`;

/** An internal id (`ws_01a210cc-…`, cut short or whole), whatever its kind's prefix. */
const INTERNAL_ID = /\b[a-z]{2,3}_[0-9a-f]{8}(?:-[0-9a-f]{1,12}){0,4}…?/g;
/** The noun an id is usually written after (`workstream ws_…`), so no stray noun is left behind. */
const NAMED_ID =
  /\b(?:workstream|task|post|update|session|batch|row|run)\s+(?=[a-z]{2,3}_[0-9a-f]{8})/gi;
const STEP_INDEX = /,?\s*\bstep[ _-]?index\b\s*[:=]?\s*\d+/gi;
const HOME_PATH =
  /(?:\/Users|\/home)\/[^\s'"`)\],;]+?(?=[.:]?(?:\s|$|['"`)\],;]))|~\/[^\s'"`)\],;]+?(?=[.:]?(?:\s|$|['"`)\],;]))/g;

/** A home-folder path says nothing to a reader of Linear and names the builder's folders: only its last part stays. */
const lastPart = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? '';

/**
 * What a reader of Linear needs and no more: internal ids, step indexes and paths in the builder's home folder
 * are removed from the agent's words in code, whatever the agent was asked.
 */
function plainWords(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(NAMED_ID, '')
        .replace(INTERNAL_ID, '')
        .replace(STEP_INDEX, '')
        .replace(HOME_PATH, lastPart)
        .replace(/\(\s*[,;]?\s*\)/g, '')
        .replace(/\(\s*,\s*/g, '(')
        .replace(/\s*,\s*\)/g, ')')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([.,;:])/g, '$1')
        .trimEnd(),
    )
    .join('\n');
}

/**
 * The body as it is written: line ends are real ones (a typed backslash and n, which the agent's tool call can
 * carry through, becomes a line break), ids, step indexes and home-folder paths are gone, and the ends are
 * trimmed.
 */
export function cleanBody(body: string): string {
  return plainWords(body.replace(/\r\n?/g, '\n').replace(/(?<!\\)\\n/g, '\n')).trim();
}

/** Text from the run's facts, as the agent is shown it: the same removals, line ends untouched. */
export const plainFact = (text: string): string => plainWords(text);

/**
 * The whole comment: the cleaned body, 10db's own part when it has one (pictures, or why there are none; it is
 * built by 10db, so it is not cleaned), a blank line, the footer.
 */
export const commentText = (
  body: string,
  post: { readonly event: string; readonly attempt: number },
  own = '',
): string => `${cleanBody(body)}\n\n${own === '' ? '' : `${own}\n\n`}${footerOf(post)}`;

/** The line an agent ends with when Linear answered that it is not signed in: its rows are held, not failed. */
export const SIGNED_OUT_LINE = 'Linear: not signed in';

const SIGNED_OUT = /^\s*[-*]?\s*`?linear:\s*not signed in\.?`?\s*$/i;

/** Whether a message has the signed-out line on a line of its own (a bullet or backticks allowed). */
export const saysSignedOut = (text: string): boolean =>
  text.split(/\r?\n/).some((line) => SIGNED_OUT.test(line));

/** What the agent's closing message says of one update: Linear's comment id, or the words Linear failed with. */
export type WrittenLine =
  | { readonly postId: LinearPostId; readonly commentId: string }
  | { readonly postId: LinearPostId; readonly failure: string };

const WRITTEN_LINE = /^\s*[-*]?\s*`?(lnp_[0-9a-f-]{36})`?\s*:\s*(.+?)\s*$/;
const COMMENT_ID = /^`?([A-Za-z0-9_-]{4,64})`?$/;
const FAILED = /^failed\s*:\s*(.+)$/i;

/**
 * Reads the lines of the agent's closing message, `<post id>: <comment id>` or `<post id>: failed: <Linear's
 * words>`; any other line is not read.
 */
export function parseWrittenLines(text: string): WrittenLine[] {
  const out: WrittenLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = WRITTEN_LINE.exec(line);
    if (match === null) continue;
    const postId = LinearPostId.safeParse(match[1]);
    const rest = match[2] ?? '';
    if (!postId.success) continue;
    const failure = FAILED.exec(rest)?.[1];
    if (failure !== undefined) {
      out.push({ postId: postId.data, failure: failure.slice(0, 500) });
      continue;
    }
    const commentId = COMMENT_ID.exec(rest)?.[1];
    if (commentId !== undefined) out.push({ postId: postId.data, commentId });
  }
  return out;
}
