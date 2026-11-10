// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10: a before shows the page
// before the task's first edit. It is asked only while the task has started nothing (a pass page: no
// turn; a task outside a pass: no session) and has no kept work, and a finished one is kept only when
// the task recorded no call that may write at or before the shot's end.

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

/** The tools that may change a file; any Bash call may. */
const WRITING_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];

/** Whether a before may still be asked for the task. */
export function beforeAllowed(facts: BeforeFacts): boolean {
  if (facts.keptWorkSha !== null) return false;
  return facts.inPass ? facts.turns === 0 : facts.sessions === 0;
}

/** Whether the task may have written before a shot that ended at `shotEnd`: its before is then dropped. */
export function wroteBefore(calls: readonly ToolCall[], shotEnd: string): boolean {
  const end = Date.parse(shotEnd);
  return calls.some((c) => WRITING_TOOLS.includes(c.tool) && Date.parse(c.at) <= end);
}
