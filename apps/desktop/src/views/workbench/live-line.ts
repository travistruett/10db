import type { PassPageDto } from '@10db/contracts';

// Workbench spec §4.3: while a turn works, the thread ends with the kit's working line, which says how
// long it has run; the page adds what the agent is doing ("editing settings/page.tsx") and how many
// files the turn has changed so far.

type Turn = NonNullable<PassPageDto['turn']>;

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
  /** "editing settings/page.tsx"; null between tools and before the first report. */
  readonly tool: string | null;
  /** "3 files changed so far"; null before the turn has changed one. */
  readonly files: string | null;
}

/** What the working turn's line adds to the kit's: what the agent does, and the files so far. */
export function liveLine(turn: Turn): LiveLine {
  const activity = turn.activity;
  if (activity === null) return { tool: null, files: null };
  const changed = activity.filesTouched.length;
  return {
    tool: activity.tool === null ? null : doing(activity.tool, activity.target),
    files:
      changed === 0
        ? null
        : `${String(changed)} ${changed === 1 ? 'file' : 'files'} changed so far`,
  };
}
