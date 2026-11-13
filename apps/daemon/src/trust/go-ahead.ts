/** The call a go-ahead names: the tool and the whole of what it was asked to do. */
export interface GoAheadCall {
  readonly toolName: string;
  readonly summary: string;
}

/**
 * The text in a Markdown code fence one backtick longer than the longest run of backticks inside it
 * (three at least), so nothing in the text can end the fence early.
 */
export function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * The builder's go-ahead for one denied call. It names the exact action, as Claude Code's rule for a
 * user's explicit request for that action needs before a soft deny yields.
 */
export function goAheadText(call: GoAheadCall): string {
  return `I approve this exact ${call.toolName} call. Run it again as it was:\n\n${fenced(call.summary)}`;
}
