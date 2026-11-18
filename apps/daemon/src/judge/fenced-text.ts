/**
 * Text between backtick fences longer than any run of backticks inside it, so it cannot close its own fence.
 * A decision fences what a builder or an agent wrote under a line that says it is data.
 */
export function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}
