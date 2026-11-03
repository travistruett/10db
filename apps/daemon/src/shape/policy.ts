import { ShapeToolName } from '@10db/contracts';

// Shape spec §5.2. What a conversation's session starts with. Read-only comes from these lists and
// the PreToolUse hook (confinement.ts), not from a sandbox: the session has no tool that runs a
// command.

/** The built-in tools the session has; every other built-in is left out. */
export const SHAPE_BUILT_IN_TOOLS = ['Read', 'Grep', 'Glob', 'Agent'] as const;

/** Named so that a built-in a later Claude Code adds to a default set still can't reach the session. */
export const SHAPE_DISALLOWED_TOOLS = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'Monitor',
  'WebFetch',
  'WebSearch',
] as const;

/** The Shape tools this slice serves; the others come with the slices that use them. */
export const SHAPE_OFFERED_TOOLS = [ShapeToolName.NoteHeard, ShapeToolName.ProposePlan] as const;

/** Approved without a prompt; the PreToolUse hook still judges each call. */
export const SHAPE_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Grep',
  'Glob',
  ...SHAPE_OFFERED_TOOLS.map((name) => `mcp__10db__${name}`),
];

/** Appended to Claude Code's own system prompt. */
export const SHAPE_SYSTEM_PROMPT = `You are Shape, 10db's planning partner. The builder talks; you listen, read the code, and help turn the talk into a plan of goals and tasks. You are read-only: you read the project, you change nothing, and you run no command.

Messages from the builder arrive as "[m:ID] text". The ID is how a proposal cites where it came from: every proposal you make carries sourceMessageIds, at least one.

Before the builder presses Propose:
- Answer from the code. Ask the one question that matters when something is unclear.
- Echo what you have heard with note_heard (up to 12 short items). It replaces the previous echo and proposes nothing.
- Make no proposals. propose_plan is refused until the builder presses Propose.

When the builder presses Propose (a note says so), call propose_plan with the whole plan: goals with their tasks, loose tasks, and records for decisions the builder made. Every call states everything; a row you leave out moves to Earlier. Give each task acceptance criteria that a person could check, the areas it touches, and a size (S, M or L; split anything larger). If propose_plan returns errors, they are all of them: fix them all and call it again. A Propose Again asks you to re-split and re-size everything the builder has not pinned; keep what is pinned as it is.

After a plan is accepted you may call propose_plan on your own after a message, when the builder's talk changes it.

Be brief. Name files and paths when you cite the code.`;

/** What a Propose turn is told, and what the transcript's note says. */
export function proposeNote(again: boolean): {
  readonly note: string;
  readonly instruction: string;
} {
  return again
    ? {
        note: 'Propose Again',
        instruction:
          'The builder pressed Propose Again: re-split and re-size everything not pinned from everything so far, and call propose_plan with the whole plan.',
      }
    : {
        note: 'Propose',
        instruction:
          'The builder pressed Propose: propose a plan from everything so far. Call propose_plan with the whole plan.',
      };
}
