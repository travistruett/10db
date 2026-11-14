import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConversationId,
  ConversationItemBody,
  ConversationItemId,
  type ConversationFullDto,
  type ConversationItemKind,
  type ToolCallHunk,
} from '@10db/contracts';
import type { Json } from '@10db/db';

// Sessions spec §5.2, §6.2: what an item cannot hold is kept beside it on disk: a call's whole output,
// an edit's whole patch, and the rest of a text past the body cap. The path is made of ids only.

/** The most UTF-16 units a new item's JSON body holds. */
export const BODY_CAP_CHARS = 32_768;
/** How much of a text over the cap the item keeps. */
export const CAPPED_TEXT_CHARS = 30_000;
/** The most of a call's output kept on disk: its tail, past a line saying how much was cut. */
export const FULL_OUTPUT_MAX_CHARS = 4_000_000;
/** How long a string of a capped call's other fields, or a plan step, may be. */
const FIELD_CHARS = 2_000;
/** How many entries of a list a capped call keeps. */
const LIST_ENTRIES = 50;

const FILES = { output: 'output.txt', patch: 'patch.diff', text: 'body.txt' } as const;

export interface FullOutput {
  readonly output?: string;
  readonly patch?: string;
  readonly text?: string;
}

/** The folder an item's full output lives in. Each id is parsed again, so no path is made from other text. */
export function fullOutputDir(
  dataDir: string,
  conversationId: ConversationId,
  itemId: ConversationItemId,
): string {
  return join(
    dataDir,
    'conversations',
    ConversationId.parse(conversationId),
    'items',
    ConversationItemId.parse(itemId),
  );
}

/** A call's output as kept on disk: at most the last `FULL_OUTPUT_MAX_CHARS`, saying what was cut. */
export function boundedOutput(output: string): string {
  if (output.length <= FULL_OUTPUT_MAX_CHARS) return output;
  const cut = output.length - FULL_OUTPUT_MAX_CHARS;
  return `[${String(cut)} characters cut from the start]\n${output.slice(cut)}`;
}

/** The items of a conversation that keep anything on disk. */
export function itemsWithFull(dataDir: string, conversationId: ConversationId): Set<string> {
  const dir = join(dataDir, 'conversations', ConversationId.parse(conversationId), 'items');
  return new Set(existsSync(dir) ? readdirSync(dir) : []);
}

/** Writes each part given, mode 600; answers whether it wrote any. */
export function writeFullOutput(
  dataDir: string,
  conversationId: ConversationId,
  itemId: ConversationItemId,
  full: FullOutput,
): boolean {
  const parts = [
    [FILES.output, full.output],
    [FILES.patch, full.patch],
    [FILES.text, full.text],
  ].flatMap(([name, value]) =>
    name === undefined || value === undefined ? [] : [[name, value] as const],
  );
  if (parts.length === 0) return false;
  const dir = fullOutputDir(dataDir, conversationId, itemId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, value] of parts) writeFileSync(join(dir, name), value, { mode: 0o600 });
  return true;
}

export function readFullOutput(
  dataDir: string,
  conversationId: ConversationId,
  itemId: ConversationItemId,
): ConversationFullDto {
  const dir = fullOutputDir(dataDir, conversationId, itemId);
  const read = (name: string): string | null => {
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
  return { output: read(FILES.output), patch: read(FILES.patch), text: read(FILES.text) };
}

/** Hunks as a unified diff's hunk sections, each side's lines whole. */
function patchOf(hunks: readonly ToolCallHunk[]): string {
  const lines = (text: string, mark: string): string[] =>
    text === '' ? [] : text.split('\n').map((line) => `${mark}${line}`);
  return hunks
    .map((h) =>
      [
        `@@ -${String(h.oldStart)},${String(h.oldLines)} +${String(h.newStart)},${String(h.newLines)} @@`,
        ...lines(h.before, '-'),
        ...lines(h.after, '+'),
      ].join('\n'),
    )
    .join('\n')
    .concat('\n');
}

const fits = (body: unknown): boolean => JSON.stringify(body).length <= BODY_CAP_CHARS;

/** A JSON value with every string cut to `FIELD_CHARS` and every list to `LIST_ENTRIES`. */
function shortened(value: Json): Json {
  if (typeof value === 'string') return value.slice(0, FIELD_CHARS);
  if (Array.isArray(value)) return value.slice(0, LIST_ENTRIES).map(shortened);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, shortened(v)]));
}

/**
 * An item body under the cap, and what it left out. A body whose JSON fits is kept as it
 * is; a longer text keeps its first 30,000 characters; a longer edit keeps the hunks that fit, marked
 * truncated, with its whole patch; a longer command keeps the start of its command. Pure.
 */
export function capItemBody(
  kind: ConversationItemKind,
  body: Json,
): { readonly body: Json; readonly full: { text?: string; patch?: string } | null } {
  if (fits(body)) return { body, full: null };
  switch (kind) {
    case 'message':
    case 'agent_message':
    case 'reasoning':
    case 'digest':
    case 'notice': {
      const parsed = ConversationItemBody[kind].safeParse(body);
      if (!parsed.success || !('text' in parsed.data)) return { body, full: null };
      const { text } = parsed.data;
      return { body: { ...parsed.data, text: text.slice(0, CAPPED_TEXT_CHARS) }, full: { text } };
    }
    case 'tool_call': {
      const parsed = ConversationItemBody.tool_call.safeParse(body);
      if (!parsed.success) return { body, full: null };
      const call = parsed.data;
      if (call.kind === 'edit') {
        // Counted as the JSON grows: the empty list, then each hunk and its comma.
        let size = JSON.stringify({ ...call, hunks: [], truncated: true }).length;
        const kept: ToolCallHunk[] = [];
        for (const hunk of call.hunks) {
          size += JSON.stringify(hunk).length + (kept.length === 0 ? 0 : 1);
          if (size > BODY_CAP_CHARS) break;
          kept.push(hunk);
        }

        return {
          body: { ...call, hunks: kept, truncated: true },
          full: { patch: patchOf(call.hunks) },
        };
      }
      if (call.kind === 'command')
        return {
          body: { ...call, command: call.command.slice(0, CAPPED_TEXT_CHARS) },
          full: { text: call.command },
        };
      // Any other call: its long strings and lists are cut, and the whole call is kept as text.
      return { body: shortened(body), full: { text: JSON.stringify(call, null, 2) } };
    }
    case 'plan': {
      const parsed = ConversationItemBody.plan.safeParse(body);
      if (!parsed.success) return { body, full: null };
      const steps: (typeof parsed.data.steps)[number][] = [];
      for (const step of parsed.data.steps) {
        const cut = { ...step, text: step.text.slice(0, FIELD_CHARS) };
        if (!fits({ steps: [...steps, cut] })) break;
        steps.push(cut);
      }
      return {
        body: { steps },
        full: { text: parsed.data.steps.map((s) => `- [${s.status}] ${s.text}`).join('\n') },
      };
    }
    case 'card':
    case 'shape_event':
    case 'turn_marker':
      return { body, full: null };
  }
}
