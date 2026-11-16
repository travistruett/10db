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

const FILE_HEADER = /^diff --git a\/.* b\/(.*)$/;
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
    const header = FILE_HEADER.exec(line);
    if (header !== null) {
      if (file !== null) closeHunk(file);
      file = { path: header[1] ?? '', status: 'M', hunks: [], current: null };
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
      else if (line.startsWith('rename to ')) file.status = 'R';
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
