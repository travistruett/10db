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
    'State the whole plan: goals, loose tasks, landings, records, questions (each with about, the key of the goal or task it belongs to) and, once something is converted, additions, changes and removals. Every call restates everything; rows you leave out move to Earlier. Refused until the builder has pressed Propose. Every error comes back at once; fix them all and call again.',
  attach: 'Attach a Mermaid diagram, a chart or an HTML mockup to a proposed task or goal.',
  write_spec:
    "Write an effort's spec (the goal's or loose task's key, and the spec in Markdown). Required before Convert for an effort that needs one; propose_plan answers needSpec when it does.",
  report_finding:
    'Reviewers only, from the scope, engineering or rehearsal subagent; 10db stamps which one and refuses the call from anyone else. Report a finding, or a question the implementer would have to ask, under an effort or one of its tasks. The rehearsal sets final on its closing call (a none, or the last question) to mark the task read. Answers the findingId.',
  resolve_finding:
    'Mark a finding resolved once a propose_plan call has answered it, with a one-line how. The builder dismisses the ones you leave.',
  find_records:
    'Search the decisions and principles that apply to this project, and its earlier conversations. Each hit carries its date and, for a principle, its kind, topic key and scope. Cite what you find, with its date.',
  see_screen:
    "Look at one of 10db's own screens: factory, board, inbox, plan (this conversation), or task with a taskId (that task's drawer), at a window width of 480 to 1600 px (default 1200) and height of 400 to 2000 (default 900). Answers a picture of the screen with this project's real data as it is now. It is only a picture: you cannot click, type or scroll, and taking it changes nothing. A screen that can't be drawn is refused with the reason. Each picture stays in your context and a conversation holds 12 at most, fewer when images dropped into it took the room, so ask for the one screen and size you need.",
};
