import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** The most UTF-16 units a new item's JSON body holds (call 31). */
export const BODY_CAP_CHARS = 32_768;
/** How much of a text over the cap the item keeps. */
export const CAPPED_TEXT_CHARS = 30_000;

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

/**
 * An item body under the cap, and what it left out (call 31). A body whose JSON fits is kept as it
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
      return { body, full: null };
    }
    case 'card':
    case 'plan':
    case 'shape_event':
    case 'turn_marker':
      return { body, full: null };
  }
}
