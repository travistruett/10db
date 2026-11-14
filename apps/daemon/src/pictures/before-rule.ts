// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10: a before shows the page
// before the task's first edit. It is asked only while the task has started nothing (a pass page: no
// turn; a task outside a pass: no session) and has no kept work, and a finished one is kept only when
// the task recorded no call that may write at or before the shot's end. Codex reports a call only once it
// has run, so a Codex session that began by then may have written with nothing reported yet.

/** What the before rule reads of a task. */
export interface BeforeFacts {
  readonly inPass: boolean;
  /** Its pass turns, on any run. */
  readonly turns: number;
  /** Its sessions, on any run. */
  readonly sessions: number;
  /** Work a take-out kept for it; null with none. */
  readonly keptWorkSha: string | null;
}

/** A tool call a session of the task reported, and when. */
export interface ToolCall {
  readonly tool: string;
  readonly at: string;
}

/** What a task's sessions did, as the before rule reads it. */
export interface TaskActivity {
  readonly calls: readonly ToolCall[];
  /** When each of the task's Codex sessions started. */
  readonly codexStarts: readonly string[];
}

/**
 * The tools that may change a file, by the `harnessTool` a tool call carries: Claude Code's writers
 * and any Bash call, and Codex's commands (whatever card they show as) and patches.
 */
const WRITING_TOOLS: readonly string[] = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'command',
  'apply_patch',
];

/** Whether a before may still be asked for the task. */
export function beforeAllowed(facts: BeforeFacts): boolean {
  if (facts.keptWorkSha !== null) return false;
  return facts.inPass ? facts.turns === 0 : facts.sessions === 0;
}

/** Whether the task may have written before a shot that ended at `shotEnd`: its before is then dropped. */
export function wroteBefore(activity: TaskActivity, shotEnd: string): boolean {
  const end = Date.parse(shotEnd);
  return (
    activity.calls.some((c) => WRITING_TOOLS.includes(c.tool) && Date.parse(c.at) <= end) ||
    activity.codexStarts.some((at) => Date.parse(at) <= end)
  );
}
