import type { PassPageDto } from '@10db/contracts';

// Workbench spec §4.3: while a turn works, the thread ends with one line saying how long it has run and
// what the agent is doing ("Working · 4 min · editing settings/page.tsx"), and under it how many files
// the turn has changed so far.

type Turn = NonNullable<PassPageDto['turn']>;

const MINUTE_MS = 60_000;

/** What each tool is doing, said as a verb; a tool not here is "using <name>". */
const VERB: Readonly<Record<string, string>> = {
  Edit: 'editing',
  MultiEdit: 'editing',
  Write: 'editing',
  NotebookEdit: 'editing',
  Read: 'reading',
  Bash: 'running',
  Grep: 'searching',
  Glob: 'searching',
};

/** Tools whose target is a file path, shortened to its last two parts for a narrow window. */
const FILE_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Read',
]);

function shortPath(path: string): string {
  return path.split('/').slice(-2).join('/');
}

function doing(tool: string, target: string | null): string {
  const verb = VERB[tool] ?? `using ${tool}`;
  if (target === null) return verb;
  return `${verb} ${FILE_TOOLS.has(tool) ? shortPath(target) : target}`;
}

export interface LiveLine {
  /** "Working · 4 min · editing settings/page.tsx". */
  readonly doing: string;
  /** "3 files changed so far"; null before the turn has changed one. */
  readonly files: string | null;
}

/** The working turn's live line at `now` (epoch ms). */
export function liveLine(turn: Turn, now: number): LiveLine {
  const minutes = Math.max(0, Math.floor((now - Date.parse(turn.startedAt)) / MINUTE_MS));
  const elapsed = `Working · ${String(minutes)} min`;
  const activity = turn.activity;
  if (activity === null) return { doing: elapsed, files: null };
  const changed = activity.filesTouched.length;
  return {
    doing:
      activity.tool === null ? elapsed : `${elapsed} · ${doing(activity.tool, activity.target)}`,
    files:
      changed === 0
        ? null
        : `${String(changed)} ${changed === 1 ? 'file' : 'files'} changed so far`,
  };
}
