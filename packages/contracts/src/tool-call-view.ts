import { z } from 'zod';
import { LimitName } from './trust-policy';

type ValueOf<T> = T[keyof T];

export const ToolCallStatus = {
  Running: 'running',
  Done: 'done',
  Failed: 'failed',
  Denied: 'denied',
} as const;
export type ToolCallStatus = ValueOf<typeof ToolCallStatus>;

/** What a call does, whichever agent made it: the kind decides the card that draws it. */
export const ToolCallKind = {
  Command: 'command',
  Edit: 'edit',
  Read: 'read',
  Search: 'search',
  Mcp: 'mcp',
  Subagent: 'subagent',
  Web: 'web',
  Other: 'other',
} as const;
export type ToolCallKind = ValueOf<typeof ToolCallKind>;

export const EditChange = { Add: 'add', Delete: 'delete', Update: 'update', Move: 'move' } as const;
export type EditChange = ValueOf<typeof EditChange>;

/**
 * Who denied a call: the builder on a card, the session's judge at a limit, or 10db (the guard's
 * coordination rules and the rules floor).
 */
export const DeniedBy = { Builder: 'builder', TenDb: '10db', Judge: 'judge' } as const;
export type DeniedBy = ValueOf<typeof DeniedBy>;

/** The most of a command's output, or an MCP result, a view keeps: its tail, in JS characters. */
export const OUTPUT_TAIL_CHARS = 4_096;
/** The most of a call's input a view shows. */
export const PREVIEW_CHARS = 200;

const Count = z.int().nonnegative();

/** One hunk of an edit: its line numbers as a unified diff gives them, and each side's text. */
export const ToolCallHunk = z.object({
  oldStart: Count,
  oldLines: Count,
  newStart: Count,
  newLines: Count,
  before: z.string(),
  after: z.string(),
});
export type ToolCallHunk = z.infer<typeof ToolCallHunk>;

const common = {
  id: z.string().min(1),
  /** The agent's own name for the tool: `Edit`, `Bash`, `apply_patch`, `command`. */
  harnessTool: z.string().min(1),
  status: z.enum(ToolCallStatus),
  /** The call's subject, at most 120 characters; the card adds the verb. */
  title: z.string(),
  startedAt: z.iso.datetime(),
  durationMs: Count.nullable(),
  parentId: z.string().min(1).nullable(),
  /** 10db's reason, when the guard or the broker denied the call. */
  refusal: z.string().nullable(),
  /** Set only on a denied call, and null where the agent gives no way to tell. */
  deniedBy: z.enum(DeniedBy).nullable(),
  /** The limit the judge stopped the call at; set only when the judge denied it. */
  limit: z.enum(LimitName).nullable(),
  /** Whether the builder's go-ahead clears the judge's denial; set only when the judge denied it. */
  soft: z.boolean().nullable(),
};

const Preview = z.string().max(PREVIEW_CHARS);
const Tail = z.string().max(OUTPUT_TAIL_CHARS);

const ToolCallVariants = z.discriminatedUnion('kind', [
  z.object({
    ...common,
    kind: z.literal(ToolCallKind.Command),
    command: z.string(),
    cwd: z.string().nullable(),
    outputTail: Tail,
    /** Every UTF-8 byte the command printed, not only the tail's. */
    outputBytes: Count,
    exitCode: z.int().nullable(),
  }),
  z.object({
    ...common,
    kind: z.literal(ToolCallKind.Edit),
    path: z.string().min(1),
    change: z.enum(EditChange),
    movePath: z.string().nullable(),
    hunks: z.array(ToolCallHunk),
    addedLines: Count,
    removedLines: Count,
    /** Some hunks or lines were left out: the edit passed the cap, or could not be diffed in time. */
    truncated: z.boolean(),
  }),
  z.object({
    ...common,
    kind: z.literal(ToolCallKind.Read),
    path: z.string().min(1),
    range: z.object({ offset: Count, limit: z.int().positive().nullable() }).nullable(),
  }),
  z.object({
    ...common,
    kind: z.literal(ToolCallKind.Search),
    pattern: z.string(),
    paths: z.array(z.string()).nullable(),
    matchCount: Count.nullable(),
  }),
  z.object({
    ...common,
    kind: z.literal(ToolCallKind.Mcp),
    server: z.string(),
    tool: z.string(),
    argumentsPreview: Preview,
    resultTail: Tail.nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    ...common,
    kind: z.literal(ToolCallKind.Subagent),
    agent: z.string(),
    promptPreview: Preview,
    model: z.string().nullable(),
  }),
  z.object({
    ...common,
    kind: z.literal(ToolCallKind.Web),
    query: z.string().nullable(),
    url: z.string().nullable(),
  }),
  z.object({
    ...common,
    kind: z.literal(ToolCallKind.Other),
    name: z.string(),
    inputPreview: Preview,
  }),
]);

/** One tool call as every agent's adapter reports it (sessions spec §5.2). */
export const ToolCallView = ToolCallVariants.superRefine((view, ctx) => {
  if (view.deniedBy !== null && view.status !== ToolCallStatus.Denied)
    ctx.addIssue({
      code: 'custom',
      path: ['deniedBy'],
      message: 'Only a denied call has a denier',
    });
  if (view.deniedBy !== DeniedBy.Judge && (view.limit !== null || view.soft !== null))
    ctx.addIssue({
      code: 'custom',
      path: ['limit'],
      message: 'Only a call the judge denied has a limit',
    });
});
export type ToolCallView = z.infer<typeof ToolCallView>;
