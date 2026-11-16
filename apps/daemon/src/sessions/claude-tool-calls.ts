import {
  DeniedBy,
  EditChange,
  OUTPUT_TAIL_CHARS,
  PREVIEW_CHARS,
  ToolCallStatus,
  type LimitName,
  type ToolCallHunk,
  type ToolCallView,
} from '@10db/contracts';
import { z } from 'zod';
import { BEFORE_TEXT_MAX_BYTES, type BeforeText } from './before-text';
import { EDIT_LINES_CAP, hunksOfTexts, unifiedPatch, type EditHunks } from './hunks';
import { titled, type UntitledToolCall } from './tool-target';
import { PlanStepStatus, type PlanStep, type SessionEvent } from './types';

// Sessions spec §5.2: a Claude Code tool use and its result, as the typed view every card reads.

export interface ClaudeToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  /** The tool use of the subagent that made this call; null for the session's own. */
  readonly parentId: string | null;
}

/** Who denied a call and why; `limit` and `soft` only when the judge did. */
export interface ClaudeDenial {
  readonly by: DeniedBy;
  readonly reason: string;
  readonly limit: LimitName | null;
  readonly soft: boolean | null;
}

export interface ClaudeToolResult {
  readonly isError: boolean;
  readonly denial: ClaudeDenial | null;
  /** A string, or content blocks of which only text blocks are read. */
  readonly content: unknown;
}

const UNREAD: BeforeText = { kind: 'unread' };

// SDK tool input is untyped: each tool's shape is checked loosely, so an added field still passes.
const Text = z.string();
const Path = z.string().min(1);
const BashInput = z.looseObject({ command: Text });
const EditInput = z.looseObject({
  file_path: Path,
  old_string: Text,
  new_string: Text,
  replace_all: z.boolean().optional(),
});
const MultiEditInput = z.looseObject({
  file_path: Path,
  edits: z.array(
    z.looseObject({ old_string: Text, new_string: Text, replace_all: z.boolean().optional() }),
  ),
});
const WriteInput = z.looseObject({ file_path: Path, content: Text });
const NotebookInput = z.looseObject({ notebook_path: Path });
const ReadInput = z.looseObject({
  file_path: Path,
  offset: z.int().nonnegative().optional(),
  limit: z.int().positive().optional(),
});
const SearchInput = z.looseObject({ pattern: Text, path: Path.optional() });
const SubagentInput = z.looseObject({
  subagent_type: z.string().min(1),
  prompt: Text,
  model: z.string().min(1).optional(),
});
const FetchInput = z.looseObject({ url: z.string().min(1) });
const SearchWebInput = z.looseObject({ query: z.string().min(1) });
const TodoInput = z.looseObject({
  todos: z.array(z.looseObject({ content: Text, status: z.enum(PlanStepStatus) })),
});
const TextBlock = z.looseObject({ type: z.literal('text'), text: Text });
const AskInput = z.looseObject({
  questions: z.array(z.looseObject({ question: Text })).min(1),
});

/** The tools whose target's previous text an edit card diffs against. */
const DIFFED = new Set(['Write', 'Edit', 'MultiEdit']);
const FilePathInput = z.looseObject({ file_path: Path });
/** The before-texts kept for calls whose use hasn't been mapped yet. */
const BEFORE_TEXTS_KEPT = 256;

function preview(input: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    json = undefined;
  }
  return (json ?? '').slice(0, PREVIEW_CHARS);
}

/** The line `needle` starts on in `text`, or 1 when the text is unread or holds no such string. */
function lineOf(text: string | null, needle: string): number {
  if (text === null || needle === '') return 1;
  const at = text.indexOf(needle);
  if (at < 0) return 1;
  let line = 1;
  for (let i = 0; i < at; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * `text` with every `old` replaced by `next`, built to at most `max` characters, since an agent's short
 * match and long replacement can multiply a file many times over. Cut short, `before` is only the part of
 * `text` that `after` was built from.
 */
function replacedAll(
  text: string,
  old: string,
  next: string,
  max: number,
): { readonly before: string; readonly after: string; readonly cut: boolean } {
  const parts: string[] = [];
  let length = 0;
  let from = 0;
  for (let at = text.indexOf(old); at >= 0; at = text.indexOf(old, from)) {
    const piece = `${text.slice(from, at)}${next}`;
    const room = max - length;
    if (piece.length > room) {
      parts.push(piece.slice(0, room));
      const covered = room <= at - from ? from + room : at + old.length;
      return { before: text.slice(0, covered), after: parts.join(''), cut: true };
    }
    parts.push(piece);
    length += piece.length;
    from = at + old.length;
  }
  const rest = text.slice(from);
  const room = max - length;
  if (rest.length > room) {
    parts.push(rest.slice(0, room));
    return { before: text.slice(0, from + room), after: parts.join(''), cut: true };
  }
  parts.push(rest);
  return { before: text, after: parts.join(''), cut: false };
}

/** One stretch of text an edit changed, from which its whole patch can be made again. */
interface Piece {
  readonly before: string;
  readonly after: string;
  readonly firstLine: number;
}

/** An edit's hunks with the texts they were made from, so a cut edit's whole patch can be kept. */
interface Diffed extends EditHunks {
  readonly pieces: readonly Piece[];
}

function diffed(before: string, after: string, firstLine = 1): Diffed {
  return { ...hunksOfTexts(before, after, firstLine), pieces: [{ before, after, firstLine }] };
}

/** Several edits' hunks as one: whole edits, in order, while their changed lines fit the cap. */
function joined(parts: readonly Diffed[]): Diffed {
  const hunks: ToolCallHunk[] = [];
  let budget = EDIT_LINES_CAP;
  let full = false;
  let truncated = false;
  for (const part of parts) {
    const changed = part.addedLines + part.removedLines;
    if (full || changed > budget) {
      full = true;
      truncated = true;
      continue;
    }
    budget -= changed;
    truncated ||= part.truncated;
    hunks.push(...part.hunks);
  }
  return {
    hunks,
    addedLines: parts.reduce((sum, p) => sum + p.addedLines, 0),
    removedLines: parts.reduce((sum, p) => sum + p.removedLines, 0),
    truncated,
    pieces: parts.flatMap((p) => p.pieces),
  };
}

type Common = Pick<
  ToolCallView,
  | 'id'
  | 'harnessTool'
  | 'status'
  | 'startedAt'
  | 'durationMs'
  | 'parentId'
  | 'refusal'
  | 'deniedBy'
  | 'limit'
  | 'soft'
>;

/** Takes an edit's whole patch when its hunks were cut. */
type KeepPatch = (patch: string) => void;

function editOf(
  common: Common,
  path: string,
  change: EditChange,
  edit: Diffed,
  keep: KeepPatch,
): UntitledToolCall {
  if (edit.truncated && edit.pieces.length > 0)
    keep(edit.pieces.map((p) => unifiedPatch(p.before, p.after, p.firstLine)).join(''));
  return {
    ...common,
    kind: 'edit',
    path,
    change,
    movePath: null,
    hunks: [...edit.hunks],
    addedLines: edit.addedLines,
    removedLines: edit.removedLines,
    truncated: edit.truncated,
  };
}

function untitled(
  use: ClaudeToolUse,
  common: Common,
  before: (path: string) => BeforeText,
  keep: KeepPatch,
): UntitledToolCall {
  const other: UntitledToolCall = {
    ...common,
    kind: 'other',
    name: use.name,
    inputPreview: preview(use.input),
  };
  switch (use.name) {
    case 'Bash': {
      const input = BashInput.safeParse(use.input);
      if (!input.success) return other;
      return {
        ...common,
        kind: 'command',
        command: input.data.command,
        cwd: null,
        outputTail: '',
        outputBytes: 0,
        exitCode: null,
      };
    }
    case 'Edit': {
      const input = EditInput.safeParse(use.input);
      if (!input.success) return other;
      const { file_path: path, old_string: old, new_string: next } = input.data;
      const read = before(path);
      const current = read.kind === 'text' ? read.text : null;
      if (input.data.replace_all === true && old !== '') {
        // Every occurrence changes: the whole file is diffed when its text is known, and without it
        // the one replacement shown is flagged as only part of the edit.
        if (current?.includes(old) === true) {
          const replaced = replacedAll(current, old, next, BEFORE_TEXT_MAX_BYTES);
          const edit = diffed(replaced.before, replaced.after);
          return editOf(
            common,
            path,
            EditChange.Update,
            replaced.cut ? { ...edit, truncated: true } : edit,
            keep,
          );
        }
        return editOf(
          common,
          path,
          EditChange.Update,
          {
            ...diffed(old, next, lineOf(current, old)),
            truncated: true,
          },
          keep,
        );
      }
      return editOf(common, path, EditChange.Update, diffed(old, next, lineOf(current, old)), keep);
    }
    case 'MultiEdit': {
      const input = MultiEditInput.safeParse(use.input);
      if (!input.success) return other;
      const read = before(input.data.file_path);
      let current = read.kind === 'text' ? read.text : null;
      const parts = input.data.edits.map((edit) => {
        const { old_string: from, new_string: to } = edit;
        if (edit.replace_all === true && from !== '' && current?.includes(from) === true) {
          // Every occurrence changes, built only up to the before-text limit, as Edit's are.
          const replaced = replacedAll(current, from, to, BEFORE_TEXT_MAX_BYTES);
          const part = diffed(replaced.before, replaced.after);
          current = replaced.cut ? null : replaced.after;
          return replaced.cut ? { ...part, truncated: true } : part;
        }
        const part = diffed(from, to, lineOf(current, from));
        if (current?.includes(from) === true && from !== '')
          current = current.replace(from, () => to);
        return part;
      });
      return editOf(common, input.data.file_path, EditChange.Update, joined(parts), keep);
    }
    case 'Write': {
      const input = WriteInput.safeParse(use.input);
      if (!input.success) return other;
      const read = before(input.data.file_path);
      switch (read.kind) {
        case 'absent':
          return editOf(
            common,
            input.data.file_path,
            EditChange.Add,
            diffed('', input.data.content),
            keep,
          );
        case 'text':
          return editOf(
            common,
            input.data.file_path,
            EditChange.Update,
            diffed(read.text, input.data.content),
            keep,
          );
        case 'unread':
          // 10db won't read what was there, so the whole new file shows as added.
          return editOf(
            common,
            input.data.file_path,
            EditChange.Update,
            diffed('', input.data.content),
            keep,
          );
      }
      return other;
    }
    case 'NotebookEdit': {
      const input = NotebookInput.safeParse(use.input);
      if (!input.success) return other;
      return editOf(
        common,
        input.data.notebook_path,
        EditChange.Update,
        {
          hunks: [],
          addedLines: 0,
          removedLines: 0,
          truncated: false,
          pieces: [],
        },
        keep,
      );
    }
    case 'Read': {
      const input = ReadInput.safeParse(use.input);
      if (!input.success) return other;
      const { offset, limit } = input.data;
      return {
        ...common,
        kind: 'read',
        path: input.data.file_path,
        range:
          offset === undefined && limit === undefined
            ? null
            : { offset: offset ?? 0, limit: limit ?? null },
      };
    }
    case 'Grep':
    case 'Glob': {
      const input = SearchInput.safeParse(use.input);
      if (!input.success) return other;
      return {
        ...common,
        kind: 'search',
        pattern: input.data.pattern,
        paths: input.data.path === undefined ? null : [input.data.path],
        matchCount: null,
      };
    }
    case 'Task':
    case 'Agent': {
      const input = SubagentInput.safeParse(use.input);
      if (!input.success) return other;
      return {
        ...common,
        kind: 'subagent',
        agent: input.data.subagent_type,
        promptPreview: input.data.prompt.slice(0, PREVIEW_CHARS),
        model: input.data.model ?? null,
      };
    }
    case 'AskUserQuestion': {
      // The answer form beside the call shows the options; its row needs only the questions.
      const input = AskInput.safeParse(use.input);
      if (!input.success) return other;
      return {
        ...other,
        inputPreview: input.data.questions
          .map((q) => q.question)
          .join(' · ')
          .slice(0, PREVIEW_CHARS),
      };
    }
    case 'WebFetch': {
      const input = FetchInput.safeParse(use.input);
      if (!input.success) return other;
      return { ...common, kind: 'web', query: null, url: input.data.url };
    }
    case 'WebSearch': {
      const input = SearchWebInput.safeParse(use.input);
      if (!input.success) return other;
      return { ...common, kind: 'web', query: input.data.query, url: null };
    }
    default: {
      if (!use.name.startsWith('mcp__')) return other;
      const rest = use.name.slice('mcp__'.length);
      const split = rest.indexOf('__');
      if (split <= 0 || split + 2 >= rest.length) return other;
      return {
        ...common,
        kind: 'mcp',
        server: rest.slice(0, split),
        tool: rest.slice(split + 2),
        argumentsPreview: preview(use.input),
        resultTail: null,
        error: null,
      };
    }
  }
}

/** A Claude Code tool use as a running call. Pure given `before`, and never throws. */
export function claudeToolCall(
  use: ClaudeToolUse,
  ctx: {
    readonly startedAt: Date;
    readonly before: (path: string) => BeforeText;
    /** Takes an edit's whole patch when its hunks were cut. */
    readonly patch?: (patch: string) => void;
  },
): ToolCallView {
  const common: Common = {
    id: use.id,
    harnessTool: use.name,
    status: ToolCallStatus.Running,
    startedAt: ctx.startedAt.toISOString(),
    durationMs: null,
    parentId: use.parentId,
    refusal: null,
    deniedBy: null,
    limit: null,
    soft: null,
  };
  return titled(untitled(use, common, ctx.before, ctx.patch ?? (() => undefined)));
}

/** A result's text: the string, or its text blocks joined by newlines. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      const parsed = TextBlock.safeParse(block);
      return parsed.success ? [parsed.data.text] : [];
    })
    .join('\n');
}

const tail = (text: string): string => text.slice(-OUTPUT_TAIL_CHARS);

/** The call once its result came back: its status, duration and output. */
export function claudeToolResult(
  call: ToolCallView,
  result: ClaudeToolResult,
  endedAt: Date,
): ToolCallView {
  const denial = result.denial;
  const judged = denial?.by === DeniedBy.Judge;
  const ended = {
    status:
      denial !== null
        ? ToolCallStatus.Denied
        : result.isError
          ? ToolCallStatus.Failed
          : ToolCallStatus.Done,
    durationMs: Math.max(0, endedAt.getTime() - Date.parse(call.startedAt)),
    refusal: denial?.reason ?? null,
    deniedBy: denial?.by ?? null,
    limit: judged ? denial.limit : null,
    soft: judged ? denial.soft : null,
  };
  const text = resultText(result.content);
  switch (call.kind) {
    case 'command':
      return {
        ...call,
        ...ended,
        outputTail: tail(text),
        outputBytes: Buffer.byteLength(text, 'utf8'),
      };
    case 'mcp':
      return result.isError
        ? { ...call, ...ended, resultTail: null, error: tail(text) }
        : { ...call, ...ended, resultTail: tail(text), error: null };
    case 'edit':
    case 'read':
    case 'search':
    case 'subagent':
    case 'web':
    case 'other':
      return { ...call, ...ended };
  }
}

/** `TodoWrite`'s todos as plan steps, or null when the input isn't that shape. */
export function claudePlanSteps(input: unknown): readonly PlanStep[] | null {
  const parsed = TodoInput.safeParse(input);
  return parsed.success
    ? parsed.data.todos.map((todo) => ({ text: todo.content, status: todo.status }))
    : null;
}

/** The before-texts of calls about to write, read before the tool runs and taken once mapped or ended. */
export interface BeforeTexts {
  capture(toolUseId: string, toolName: string, input: unknown, cwd: string): void;
  take(toolUseId: string): BeforeText;
  /** Whether a capture is kept for the call. */
  has(toolUseId: string): boolean;
  /** Drops the call's capture, taken or not. */
  discard(toolUseId: string): void;
  /** Drops every capture. */
  clear(): void;
}

export function createBeforeTexts(read: (cwd: string, path: string) => BeforeText): BeforeTexts {
  const kept = new Map<string, BeforeText>();
  return {
    capture(toolUseId, toolName, input, cwd) {
      if (!DIFFED.has(toolName)) return;
      const parsed = FilePathInput.safeParse(input);
      if (!parsed.success) return;
      kept.set(toolUseId, read(cwd, parsed.data.file_path));
      if (kept.size > BEFORE_TEXTS_KEPT) {
        const oldest = kept.keys().next();
        if (oldest.done !== true) kept.delete(oldest.value);
      }
    },
    take(toolUseId) {
      const text = kept.get(toolUseId) ?? UNREAD;
      kept.delete(toolUseId);
      return text;
    },
    has: (toolUseId) => kept.has(toolUseId),
    discard(toolUseId) {
      kept.delete(toolUseId);
    },
    clear() {
      kept.clear();
    },
  };
}

export interface ClaudeToolCalls {
  /**
   * `TodoWrite` gives its plan; any other tool its running call. A use seen before gives nothing.
   * A call that writes waits for its before-text (`capture`) or its result, whichever comes first,
   * because Claude Code may send the frame before the hook that reads the file.
   */
  use(use: ClaudeToolUse): SessionEvent[];
  /**
   * Reads the file a writing call is about to change, in the PreToolUse hook. Gives the call's
   * running view when its use was already waiting for this.
   */
  capture(toolUseId: string, toolName: string, input: unknown, cwd: string): SessionEvent[];
  /** A kept call's final view; nothing for an id never seen or already final. */
  result(toolUseId: string, result: Omit<ClaudeToolResult, 'denial'>): SessionEvent[];
  /**
   * Records who denied a call, for its result. A call whose result already came is corrected at
   * once: its final view again, denied, since Claude Code may report a denial after the result.
   */
  deny(toolUseId: string, denial: ClaudeDenial): SessionEvent[];
  /**
   * A turn ended: the calls that never reported a result are forgotten, except those started in the
   * background, whose result may come in a later turn.
   */
  turnEnded(): void;
  /** The session ended: nothing is kept. */
  clear(): void;
}

/** The denials kept for results still to come, and the final calls kept for a denial that follows. */
const DENIALS_KEPT = 256;

/** `map` with `key` set, its oldest entry dropped past `kept`. */
function remember<V>(map: Map<string, V>, key: string, value: V, kept: number): void {
  map.set(key, value);
  if (map.size > kept) {
    const oldest = map.keys().next();
    if (oldest.done !== true) map.delete(oldest.value);
  }
}

const BackgroundInput = z.looseObject({ run_in_background: z.literal(true) });

/** One session's tool calls, from each use to its result. */
export function createClaudeToolCalls(deps: {
  now(): Date;
  /** Reads the file a call is about to write, relative to the call's cwd. */
  read(cwd: string, path: string): BeforeText;
}): ClaudeToolCalls {
  const texts = createBeforeTexts((cwd, path) => deps.read(cwd, path));
  const running = new Map<string, ToolCallView>();
  /** The ids in `running` that were started in the background. */
  const background = new Set<string>();
  /** Writing calls whose use came before their before-text, with when it came. */
  const waiting = new Map<string, { readonly use: ClaudeToolUse; readonly startedAt: Date }>();
  const plans = new Set<string>();
  /** The whole patch of each running edit whose hunks were cut. */
  const patches = new Map<string, string>();
  const denials = new Map<string, ClaudeDenial>();
  /** Each final call with when it ended, until a denial corrects it or it ages out. */
  const finals = new Map<
    string,
    {
      readonly call: ToolCallView;
      readonly result: Omit<ClaudeToolResult, 'denial'>;
      readonly endedAt: Date;
    }
  >();
  const begin = (use: ClaudeToolUse, startedAt: Date): ToolCallView => {
    const call = claudeToolCall(use, {
      startedAt,
      before: () => texts.take(use.id),
      patch: (patch) => {
        remember(patches, use.id, patch, DENIALS_KEPT);
      },
    });
    remember(running, use.id, call, DENIALS_KEPT);
    if (BackgroundInput.safeParse(use.input).success) background.add(use.id);
    return call;
  };
  const start = (use: ClaudeToolUse, startedAt: Date): SessionEvent[] => [
    { type: 'tool_call', call: begin(use, startedAt) },
  ];
  return {
    use(use) {
      if (running.has(use.id) || plans.has(use.id) || waiting.has(use.id)) return [];
      if (use.name === 'TodoWrite') {
        plans.add(use.id);
        const steps = claudePlanSteps(use.input);
        return steps === null ? [] : [{ type: 'plan_update', steps }];
      }
      const startedAt = deps.now();
      if (
        DIFFED.has(use.name) &&
        FilePathInput.safeParse(use.input).success &&
        !texts.has(use.id)
      ) {
        remember(waiting, use.id, { use, startedAt }, DENIALS_KEPT);
        return [];
      }
      return start(use, startedAt);
    },
    capture(toolUseId, toolName, input, cwd) {
      texts.capture(toolUseId, toolName, input, cwd);
      const held = waiting.get(toolUseId);
      if (held === undefined) return [];
      waiting.delete(toolUseId);
      return start(held.use, held.startedAt);
    },
    result(toolUseId, result) {
      plans.delete(toolUseId);
      const held = waiting.get(toolUseId);
      // The result came before any before-text: the call is mapped now, as the fail-safe shows it.
      if (held !== undefined) waiting.delete(toolUseId);
      const call = held === undefined ? running.get(toolUseId) : begin(held.use, held.startedAt);
      texts.discard(toolUseId);
      const denial = denials.get(toolUseId) ?? null;
      denials.delete(toolUseId);
      if (call === undefined) return [];
      running.delete(toolUseId);
      background.delete(toolUseId);
      const patch = patches.get(toolUseId);
      patches.delete(toolUseId);
      const endedAt = deps.now();
      if (denial === null) remember(finals, toolUseId, { call, result, endedAt }, DENIALS_KEPT);
      const output = resultText(result.content);
      const full = {
        ...((call.kind === 'command' || call.kind === 'mcp') && output.length > OUTPUT_TAIL_CHARS
          ? { output }
          : {}),
        ...(patch === undefined ? {} : { patch }),
      };
      return [
        {
          type: 'tool_call',
          call: claudeToolResult(call, { ...result, denial }, endedAt),
          ...(Object.keys(full).length === 0 ? {} : { full }),
        },
      ];
    },
    deny(toolUseId, denial) {
      const final = finals.get(toolUseId);
      if (final === undefined) {
        remember(denials, toolUseId, denial, DENIALS_KEPT);
        return [];
      }
      finals.delete(toolUseId);
      return [
        {
          type: 'tool_call',
          call: claudeToolResult(final.call, { ...final.result, denial }, final.endedAt),
        },
      ];
    },
    turnEnded() {
      for (const id of [...running.keys()]) {
        if (background.has(id)) continue;
        running.delete(id);
        patches.delete(id);
        texts.discard(id);
      }
      for (const id of waiting.keys()) texts.discard(id);
      waiting.clear();
    },
    clear() {
      running.clear();
      patches.clear();
      background.clear();
      waiting.clear();
      texts.clear();
    },
  };
}
