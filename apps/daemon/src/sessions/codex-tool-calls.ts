import {
  EditChange,
  OUTPUT_TAIL_CHARS,
  PREVIEW_CHARS,
  ToolCallStatus,
  type ToolCallView,
} from '@10db/contracts';
import { z } from 'zod';
import { hunksOfPatch, hunksOfTexts, startsAsPatch, type EditHunks } from './hunks';
import { titled, type UntitledToolCall } from './tool-target';
import { PlanStepStatus, type PlanStep } from './types';

// Sessions spec §5.2 and §5.5: a Codex thread item as the typed calls every card reads. Each item is
// read loosely, so a field Codex adds still passes; an item that isn't a tool call gives none.

const Id = z.string().min(1);
const Status = z.string();

const CommandItem = z.looseObject({
  type: z.literal('commandExecution'),
  id: Id,
  command: z.string().min(1),
  cwd: z.string().nullable().optional(),
  status: Status,
  commandActions: z.array(z.unknown()).optional(),
  aggregatedOutput: z.string().nullable().optional(),
  exitCode: z.number().nullable().optional(),
  durationMs: z.number().nullable().optional(),
});
/** A command Codex reads as one file read, or as one search (call 8). */
const ReadAction = z.looseObject({ type: z.literal('read'), path: z.string().min(1) });
const SearchAction = z.looseObject({
  type: z.literal('search'),
  query: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
});
const FileChangeItem = z.looseObject({
  type: z.literal('fileChange'),
  id: Id,
  status: Status,
  changes: z.array(
    z.looseObject({
      path: z.string(),
      kind: z.looseObject({ type: z.string(), move_path: z.string().nullable().optional() }),
      diff: z.string(),
    }),
  ),
});
const McpItem = z.looseObject({
  type: z.literal('mcpToolCall'),
  id: Id,
  server: z.string().min(1),
  tool: z.string().min(1),
  status: Status,
  arguments: z.unknown().optional(),
  result: z
    .looseObject({ content: z.array(z.unknown()) })
    .nullable()
    .optional(),
  error: z.looseObject({ message: z.string() }).nullable().optional(),
  durationMs: z.number().nullable().optional(),
});
const WebSearchItem = z.looseObject({
  type: z.literal('webSearch'),
  id: Id,
  query: z.string().nullable().optional(),
  action: z
    .looseObject({ type: z.string(), url: z.string().nullable().optional() })
    .nullable()
    .optional(),
});
const CollabItem = z.looseObject({
  type: z.literal('collabAgentToolCall'),
  id: Id,
  tool: z.string().min(1),
  status: Status,
  prompt: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});
const DynamicItem = z.looseObject({
  type: z.literal('dynamicToolCall'),
  id: Id,
  tool: z.string().min(1),
  status: Status,
  arguments: z.unknown().optional(),
  durationMs: z.number().nullable().optional(),
});
const ImageViewItem = z.looseObject({
  type: z.literal('imageView'),
  id: Id,
  path: z.string().min(1),
});
const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });

export interface ItemTimes {
  readonly startedAtMs: number;
  /** Null while the item runs. */
  readonly completedAtMs: number | null;
}

/** An item's status as a call's (call 12): an unknown one reads as running until the item completes. */
function statusOf(status: string, times: ItemTimes, failedExit: boolean): ToolCallStatus {
  switch (status) {
    case 'inProgress':
      return ToolCallStatus.Running;
    case 'completed':
      return failedExit ? ToolCallStatus.Failed : ToolCallStatus.Done;
    case 'failed':
    case 'interrupted':
      return ToolCallStatus.Failed;
    case 'declined':
      return ToolCallStatus.Denied;
    default:
      return times.completedAtMs === null ? ToolCallStatus.Running : ToolCallStatus.Done;
  }
}

function preview(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  return (json ?? '').slice(0, PREVIEW_CHARS);
}

const tail = (text: string): string => text.slice(-OUTPUT_TAIL_CHARS);

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

function common(
  id: string,
  harnessTool: string,
  status: ToolCallStatus,
  times: ItemTimes,
  durationMs: number | null | undefined,
): Common {
  const measured =
    durationMs ?? (times.completedAtMs === null ? null : times.completedAtMs - times.startedAtMs);
  return {
    id,
    harnessTool,
    status,
    startedAt: new Date(times.startedAtMs).toISOString(),
    durationMs: measured === null ? null : Math.max(0, Math.round(measured)),
    parentId: null,
    // Codex's item doesn't say whether the guard or the builder declined it (call 21).
    refusal: null,
    deniedBy: null,
    limit: null,
    soft: null,
  };
}

/**
 * A change's hunks. An add or a delete is its text as added or removed, unless the text starts as a
 * unified diff and its hunks hold every line of it: a file whose text only holds a hunk header is
 * shown whole. An update is its unified diff, truncated where its hunks leave a line out; one with
 * no diff has none.
 */
function changeHunks(diff: string, change: EditChange): EditHunks {
  const parsed = hunksOfPatch(diff);
  const patch = (): EditHunks | null =>
    parsed !== null && parsed.whole && startsAsPatch(diff) ? parsed : null;
  switch (change) {
    case EditChange.Add:
      return patch() ?? hunksOfTexts('', diff);
    case EditChange.Delete:
      return patch() ?? hunksOfTexts(diff, '');
    case EditChange.Update:
    case EditChange.Move:
      return parsed ?? { hunks: [], addedLines: 0, removedLines: 0, truncated: false };
  }
}

function changeOf(kind: { type: string; move_path?: string | null | undefined }): EditChange {
  if (kind.type === 'add') return EditChange.Add;
  if (kind.type === 'delete') return EditChange.Delete;
  return typeof kind.move_path === 'string' && kind.move_path !== ''
    ? EditChange.Move
    : EditChange.Update;
}

function untitled(item: unknown, times: ItemTimes): UntitledToolCall[] {
  const cmd = CommandItem.safeParse(item);
  if (cmd.success) {
    const { data } = cmd;
    const exit = data.exitCode ?? null;
    const base = common(
      data.id,
      'command',
      statusOf(data.status, times, exit !== null && exit !== 0),
      times,
      data.durationMs,
    );
    const actions = data.commandActions ?? [];
    const only = actions.length === 1 ? actions[0] : undefined;
    const read = ReadAction.safeParse(only);
    if (read.success) return [{ ...base, kind: 'read', path: read.data.path, range: null }];
    const search = SearchAction.safeParse(only);
    if (search.success) {
      const query = search.data.query ?? '';
      const path = search.data.path ?? '';
      return [
        {
          ...base,
          kind: 'search',
          pattern: query === '' ? data.command : query,
          paths: path === '' ? null : [path],
          matchCount: null,
        },
      ];
    }
    const output = data.aggregatedOutput ?? '';
    return [
      {
        ...base,
        kind: 'command',
        command: data.command,
        cwd: data.cwd ?? null,
        outputTail: tail(output),
        outputBytes: Buffer.byteLength(output, 'utf8'),
        exitCode: exit === null ? null : Math.trunc(exit),
      },
    ];
  }
  const patch = FileChangeItem.safeParse(item);
  if (patch.success) {
    const status = statusOf(patch.data.status, times, false);
    return patch.data.changes.flatMap((c, index) => {
      if (c.path === '') return [];
      const change = changeOf(c.kind);
      const hunks = changeHunks(c.diff, change);
      return [
        {
          ...common(`${patch.data.id}:${String(index)}`, 'apply_patch', status, times, undefined),
          kind: 'edit',
          path: c.path,
          change,
          movePath: change === EditChange.Move ? (c.kind.move_path ?? null) : null,
          hunks: [...hunks.hunks],
          addedLines: hunks.addedLines,
          removedLines: hunks.removedLines,
          truncated: hunks.truncated,
        },
      ];
    });
  }
  const mcp = McpItem.safeParse(item);
  if (mcp.success) {
    const { data } = mcp;
    const text = (data.result?.content ?? [])
      .flatMap((block) => {
        const parsed = TextBlock.safeParse(block);
        return parsed.success ? [parsed.data.text] : [];
      })
      .join('\n');
    return [
      {
        ...common(
          data.id,
          `${data.server}.${data.tool}`,
          statusOf(data.status, times, false),
          times,
          data.durationMs,
        ),
        kind: 'mcp',
        server: data.server,
        tool: data.tool,
        argumentsPreview: preview(data.arguments ?? null),
        resultTail: data.result === null || data.result === undefined ? null : tail(text),
        error: data.error?.message ?? null,
      },
    ];
  }
  const web = WebSearchItem.safeParse(item);
  if (web.success) {
    const action = web.data.action;
    const url =
      (action?.type === 'openPage' || action?.type === 'findInPage') &&
      typeof action.url === 'string'
        ? action.url
        : null;
    const query = web.data.query ?? null;
    return [
      {
        ...common(web.data.id, 'web_search', statusOf('', times, false), times, undefined),
        kind: 'web',
        query: query === '' ? null : query,
        url,
      },
    ];
  }
  const collab = CollabItem.safeParse(item);
  if (collab.success) {
    const { data } = collab;
    const base = common(data.id, data.tool, statusOf(data.status, times, false), times, undefined);
    if (data.tool === 'spawnAgent')
      return [
        {
          ...base,
          kind: 'subagent',
          agent: 'subagent',
          promptPreview: (data.prompt ?? '').slice(0, PREVIEW_CHARS),
          model: data.model ?? null,
        },
      ];
    return [
      { ...base, kind: 'other', name: data.tool, inputPreview: preview(data.prompt ?? null) },
    ];
  }
  const dynamic = DynamicItem.safeParse(item);
  if (dynamic.success) {
    const { data } = dynamic;
    return [
      {
        ...common(data.id, data.tool, statusOf(data.status, times, false), times, data.durationMs),
        kind: 'other',
        name: data.tool,
        inputPreview: preview(data.arguments ?? null),
      },
    ];
  }
  const image = ImageViewItem.safeParse(item);
  if (image.success)
    return [
      {
        ...common(image.data.id, 'view_image', statusOf('', times, false), times, undefined),
        kind: 'read',
        path: image.data.path,
        range: null,
      },
    ];
  return [];
}

/** The calls a thread item holds: none for an item that isn't a tool call, one per file for a patch. */
export function codexToolCalls(item: unknown, times: ItemTimes): readonly ToolCallView[] {
  return untitled(item, times).map(titled);
}

/** A running command with more output: its tail kept to the cap, every byte counted. Any other call is as it was. */
export function withCommandOutput(call: ToolCallView, delta: string): ToolCallView {
  if (call.kind !== 'command') return call;
  return {
    ...call,
    outputTail: tail(call.outputTail + delta),
    outputBytes: call.outputBytes + Buffer.byteLength(delta, 'utf8'),
  };
}

/** Codex's turn plan as plan steps; a status 10db doesn't know reads as pending. */
export function codexPlanSteps(
  plan: readonly { readonly step: string; readonly status: string }[],
): readonly PlanStep[] {
  return plan.map(({ step, status }) => ({
    text: step,
    status:
      status === 'inProgress'
        ? PlanStepStatus.InProgress
        : status === 'completed'
          ? PlanStepStatus.Completed
          : PlanStepStatus.Pending,
  }));
}
