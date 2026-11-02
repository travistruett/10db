import type { ShapeId, SessionId, ShapeToolInputs, ShapeToolName } from '@10db/contracts';
import type { z } from 'zod';

// Shape spec §5.5. The `10db` MCP server builds a session's tool set from its row: a lane's tools
// for a workstream, these for a conversation. The tools themselves belong to the shape module,
// which hands the server its handlers.

/** A handler per Shape tool, each taking its tool's parsed input. A tool with none is not offered. */
export type ShapeToolHandlers = {
  readonly [K in ShapeToolName]?: (
    input: z.output<(typeof ShapeToolInputs)[K]>,
  ) => Promise<unknown>;
};

/** Builds the handlers for one conversation's session. */
export type ShapeToolsFor = (session: {
  readonly sessionId: SessionId;
  readonly shapeId: ShapeId;
}) => ShapeToolHandlers;

export const SHAPE_TOOL_DESCRIPTIONS: Record<ShapeToolName, string> = {
  note_heard:
    'Echo what you have heard so far as up to 12 short items (80 characters each). Replaces the previous echo. Use it before the builder presses Propose; it proposes nothing.',
  similar_tasks:
    'Finished tasks like a query, with their lane time, wall time and tokens, to base a size on.',
  propose_plan:
    'State the whole plan: goals, loose tasks, landings, records, questions and, once something is converted, additions, changes and removals. Every call restates everything; rows you leave out move to Earlier. Refused until the builder has pressed Propose. Every error comes back at once; fix them all and call again.',
  attach: 'Attach a Mermaid diagram, a chart or an HTML mockup to a proposed task or goal.',
  write_spec: "Write an effort's spec.",
  report_finding:
    'Reviewers only: report a finding, or a question the implementer would have to ask, under an effort or one of its tasks.',
  resolve_finding:
    'Mark a finding resolved once a propose_plan call has answered it, with a one-line how.',
  find_records:
    'Search the decisions that apply to this project and its earlier conversations. Cite what you find, with its date.',
};
