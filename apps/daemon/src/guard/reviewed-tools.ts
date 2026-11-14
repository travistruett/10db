/**
 * The Claude Code release whose tool list was reviewed, and the tools of it that run inside the
 * session and may go to a judge: every name its `init` lists for a session, less the tools the
 * classifier already decides (`CLASSIFIER_TOOLS`) and the ones a lane never gets
 * (`LANE_DISALLOWED_TOOLS`). A name left out keeps asking under every judge.
 *
 * A tool is listed only when it can be shown to act inside the session: `ReportFindings` takes
 * findings text and returns a count. `SendMessage` reaches other sessions, `Workflow` runs scripts
 * that start agents from Claude Code's own process, and `ListAgents` has no published contract, so
 * none of the three is listed. The release is the one `CLAUDE_CODE_VERIFIED_ON` pins; a repo test
 * fails when they differ, so a Claude Code bump brings its tools to review.
 */
export const CLAUDE_TOOLS_REVIEWED: {
  readonly version: string;
  readonly tools: ReadonlySet<string>;
} = {
  version: '2.1.302',
  tools: new Set(['ReportFindings']),
};
