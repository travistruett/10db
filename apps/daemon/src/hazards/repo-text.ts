import type { Git } from '../git';

/** The most files read, the most bytes of any one file, and the most text kept in all. */
const MAX_FILES = 60;
const MAX_FILE_BYTES = 48 * 1024;
const MAX_TOTAL_CHARS = 300_000;
/** The most lines of a file the model is given, and the most characters of a line. */
const MAX_LINES = 400;
const MAX_LINE_CHARS = 240;
/** The most tracked files looked through and the most helper-script names listed. */
const MAX_TRACKED = 100_000;
const MAX_SCRIPTS = 80;

/** What the model reads: the repository's own words, as data. */
export interface RepoText {
  /** The commit every file was read from. */
  readonly commit: string;
  readonly tracked: readonly string[];
  /** Each file read, line by line (line 1 is `lines[0]`). */
  readonly files: readonly { readonly path: string; readonly lines: readonly string[] }[];
  /** Paths of helper scripts, named and not read. */
  readonly scripts: readonly string[];
  /** Files that matched and were not read: a link, over the size cap, or past a limit. */
  readonly skipped: number;
}

const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** How early a file is read: its instructions first, then the files that name commands. */
function rank(path: string): number | null {
  const name = base(path);
  if (name === 'AGENTS.md' || name === 'CLAUDE.md') return 0;
  if (/^(?:GNUmakefile|makefile|Makefile)$/u.test(name) || name.endsWith('.mk')) return 1;
  if (/^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/u.test(name)) return 2;
  if (/^(?:justfile|Taskfile\.ya?ml)$/u.test(name)) return 2;
  if (name === 'package.json' && path.split('/').length <= 4) return 3;
  if (/^(?:README|CONTRIBUTING)\.md$/u.test(name) && path.split('/').length <= 2) return 4;
  if (path.startsWith('docs/') && name.endsWith('.md'))
    return /dev|migrat|database|setup|docker|contribut|lock|depend/iu.test(path) ? 4 : 5;
  return null;
}

const SCRIPT_FOLDERS = /(?:^|\/)(?:scripts|bin|tools)\/[^/]+$/u;
const SCRIPT_FILE = /\.(?:py|sh|js|mjs|ts|rb|pl)$/u;

/** A helper script outside any folder named for scripts is found by its name beside `AGENTS.md`'s folder. */
function isScript(path: string): boolean {
  return (
    SCRIPT_FOLDERS.test(path) ||
    (SCRIPT_FILE.test(path) &&
      /(?:^|\/)[^/]*(?:export|migrat|lock|seed|generate)[^/]*$/iu.test(path))
  );
}

function cut(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

/**
 * The repository's text for an assessment, read from the object store of the commit HEAD names:
 * the tracked file list, the instruction files, makefiles, compose files, manifests and development
 * docs, and the names of helper scripts. Nothing is run and no link is followed; every file and line
 * is size-capped. Null when git will not read the repository or it holds no file.
 */
export async function readRepoText(
  git: Pick<Git, 'survey' | 'commitAt' | 'fileAt'>,
  repoPath: string,
): Promise<RepoText | null> {
  const survey = await git.survey(repoPath, 0);
  if ('refused' in survey || survey.files.length === 0) return null;
  const commit = await git.commitAt(repoPath, 'HEAD');
  const tracked = survey.files.slice(0, MAX_TRACKED);
  const wanted = tracked
    .flatMap((path) => {
      const order = rank(path);
      return order === null ? [] : [{ path, order }];
    })
    .sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
  const files: { path: string; lines: string[] }[] = [];
  let skipped = Math.max(0, wanted.length - MAX_FILES);
  let chars = 0;
  for (const { path } of wanted.slice(0, MAX_FILES)) {
    const found = await git.fileAt(repoPath, commit, path, MAX_FILE_BYTES);
    if (found.kind !== 'file' || chars >= MAX_TOTAL_CHARS) {
      skipped += 1;
      continue;
    }
    const all = found.text.split('\n');
    // The newline that ends the last line starts no line of its own.
    if (all.at(-1) === '') all.pop();
    const lines = all.slice(0, MAX_LINES).map(cut);
    chars += lines.reduce((n, l) => n + l.length + 1, 0);
    files.push({ path, lines });
  }
  const scripts = tracked.filter(isScript).sort().slice(0, MAX_SCRIPTS);
  return { commit, tracked, files, scripts, skipped };
}
