import type { ChangedFileDto, ToolCallHunk } from '@10db/contracts';

// A task's Changes panel draws the daemon's unified diff file by file. The diff is repository text: it
// is cut into files and hunks here and drawn as text only.

export type FileStatus = 'M' | 'A' | 'D' | 'R';

export interface ChangedFileView {
  readonly path: string;
  readonly status: FileStatus;
  /** Empty for a rename with no edits and for a binary file. */
  readonly hunks: readonly ToolCallHunk[];
}

const FILE_HEADER_PREFIX = 'diff --git ';
const RENAME_TARGET_PREFIX = 'rename to ';
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '"': 34,
  '\\': 92,
};
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Draft {
  path: string;
  status: FileStatus;
  hunks: ToolCallHunk[];
  current: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    before: string[];
    after: string[];
  } | null;
}

/**
 * A path as git prints it: plain, or in double quotes with C escapes and non-ASCII bytes as octal
 * (`core.quotePath`). Anything else is returned as it is.
 */
export function unquotePath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const body = text.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    const char = body.charAt(i);
    if (char !== '\\') {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0];
    if (octal !== undefined) {
      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }
    const next = body.charAt(i + 1);
    const simple = SIMPLE_ESCAPES[next];
    if (Object.hasOwn(SIMPLE_ESCAPES, next) && simple !== undefined) bytes.push(simple);
    else bytes.push(...encoder.encode(`\\${next}`));
    i += 1;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** The end of the quoted name that starts `text`, or -1 when it never closes. */
function quotedEnd(text: string): number {
  for (let i = 1; i < text.length; i += 1) {
    if (text.charAt(i) === '\\') i += 1;
    else if (text.charAt(i) === '"') return i;
  }
  return -1;
}

/**
 * The path a `diff --git` line names: the b side. Git quotes a name that needs it, each side on its
 * own; unquoted, a path may hold spaces and " b/", so a path both sides share is found by length.
 */
function headerPath(line: string): string | null {
  if (!line.startsWith(FILE_HEADER_PREFIX)) return null;
  const rest = line.slice(FILE_HEADER_PREFIX.length);
  let b: string;
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest);
    if (end < 0) return null;
    b = rest.slice(end + 2);
  } else if (rest.endsWith('"')) {
    const at = rest.lastIndexOf(' "b/');
    if (at < 0) return null;
    b = rest.slice(at + 1);
  } else {
    const same = (rest.length - 5) / 2;
    if (Number.isInteger(same) && rest.slice(2, 2 + same) === rest.slice(rest.length - same)) {
      return rest.slice(rest.length - same);
    }
    const at = rest.lastIndexOf(' b/');
    if (at < 0) return null;
    b = rest.slice(at + 1);
  }
  const path = unquotePath(b);
  return path.startsWith('b/') ? path.slice(2) : null;
}

function closeHunk(file: Draft): void {
  const { current } = file;
  if (current === null) return;
  file.hunks.push({
    oldStart: current.oldStart,
    oldLines: current.oldLines,
    newStart: current.newStart,
    newLines: current.newLines,
    before: current.before.map((line) => `${line}\n`).join(''),
    after: current.after.map((line) => `${line}\n`).join(''),
  });
  file.current = null;
}

/** The diff's files in order; text before the first `diff --git` line is ignored. */
export function parseChanges(diff: string): ChangedFileView[] {
  const files: Draft[] = [];
  let file: Draft | null = null;
  for (const line of diff.split('\n')) {
    const header = headerPath(line);
    if (header !== null) {
      if (file !== null) closeHunk(file);
      file = { path: header, status: 'M', hunks: [], current: null };
      files.push(file);
      continue;
    }
    if (file === null) continue;
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      closeHunk(file);
      file.current = {
        oldStart: Number(hunk[1]),
        oldLines: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: Number(hunk[3]),
        newLines: hunk[4] === undefined ? 1 : Number(hunk[4]),
        before: [],
        after: [],
      };
      continue;
    }
    if (file.current === null) {
      if (line.startsWith('new file mode')) file.status = 'A';
      else if (line.startsWith('deleted file mode')) file.status = 'D';
      else if (line.startsWith(RENAME_TARGET_PREFIX)) {
        file.status = 'R';
        file.path = unquotePath(line.slice(RENAME_TARGET_PREFIX.length));
      }
      continue;
    }
    const body = line.slice(1);
    if (line.startsWith('+')) file.current.after.push(body);
    else if (line.startsWith('-')) file.current.before.push(body);
    else if (line.startsWith(' ')) {
      file.current.before.push(body);
      file.current.after.push(body);
    }
  }
  for (const done of files) closeHunk(done);
  return files.map(({ path, status, hunks }) => ({ path, status, hunks }));
}

/** The panel's "3 files +41 −6": every file counted, a binary file adding nothing. */
export function changesTotals(files: readonly ChangedFileDto[]): {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
} {
  return {
    files: files.length,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
  };
}

/** A composer's text with `quote` added on a new paragraph, so the builder types their words after it. */
export function withQuote(text: string, quote: string): string {
  return text.trim() === '' ? quote : `${text.replace(/\s+$/, '')}\n\n${quote}`;
}
