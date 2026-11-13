import type { ToolCallView } from '@10db/contracts';
import { z } from 'zod';

// Workbench spec §4.3: what a tool call aims at, for a working page's live line ("editing
// settings/page.tsx"), and the files it writes, which a turn counts as touched.

/** A tool call as the live line names it. */
export interface ToolTarget {
  readonly name: string;
  /** The file, pattern or command the call aimed at; null when it names none. */
  readonly target: string | null;
  /** The files the call writes; empty for a read, a search or a command. */
  readonly written: readonly string[];
}

/** The longest target kept: a path or a word, never a whole command or file. */
const TARGET_CHARS = 300;

/** Claude Code's tools that write the file their input names, and the key it is under. */
const WRITERS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Its other tools that aim at something their input names, and the key it is under. */
const AIMED: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Grep: 'pattern',
  Glob: 'pattern',
  WebFetch: 'url',
};

// SDK tool input is untyped; only a string under the key is read.
const StringAt = (key: string) => z.looseObject({ [key]: z.string().min(1) });

/** The first word of a command line, past the variables it sets (`CI=1 pnpm test` is `pnpm`). */
function firstWord(command: string): string | null {
  const word = command
    .trim()
    .split(/\s+/)
    .find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return word === undefined || word === '' ? null : word.slice(0, TARGET_CHARS);
}

function stringAt(input: unknown, key: string): string | null {
  const parsed = StringAt(key).safeParse(input);
  if (!parsed.success) return null;
  const value: unknown = parsed.data[key];
  return typeof value === 'string' ? value.slice(0, TARGET_CHARS) : null;
}

/** What a Claude Code tool call aims at and writes, read from its input. */
export function claudeToolTarget(name: string, input: unknown): ToolTarget {
  const writes = WRITERS[name];
  if (writes !== undefined) {
    const path = stringAt(input, writes);
    return { name, target: path, written: path === null ? [] : [path] };
  }
  if (name === 'Bash') {
    const command = stringAt(input, 'command');
    return { name, target: command === null ? null : firstWord(command), written: [] };
  }
  const aimed = AIMED[name];
  return { name, target: aimed === undefined ? null : stringAt(input, aimed), written: [] };
}

/** A Codex command, named by its first word; it writes nothing the live line can name. */
export function codexCommandTarget(command: string): ToolTarget {
  return { name: 'command', target: firstWord(command), written: [] };
}

/** A Codex patch, named by its first file; it writes every file it changes. */
export function codexPatchTarget(paths: readonly string[]): ToolTarget {
  return { name: 'apply_patch', target: paths[0] ?? null, written: [...paths] };
}

/** The longest title a tool call carries: its subject, which the card puts a verb before. */
export const TITLE_CHARS = 120;
/** The longest live-line summary. */
const SUMMARY_CHARS = 200;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A tool call before its title is set: each adapter builds one, and `titled` names it. */
export type UntitledToolCall = DistributiveOmit<ToolCallView, 'title'>;

const firstLine = (text: string): string => text.split('\n', 1)[0] ?? '';
const cut = (text: string, chars: number): string => text.slice(0, chars);

/** The call with its title: the subject each kind is about (sessions spec §5.2). */
export function titled(call: UntitledToolCall): ToolCallView {
  switch (call.kind) {
    case 'command':
      return { ...call, title: cut(firstLine(call.command), TITLE_CHARS) };
    case 'edit':
      return {
        ...call,
        title: cut(
          call.movePath === null ? call.path : `${call.path} → ${call.movePath}`,
          TITLE_CHARS,
        ),
      };
    case 'read':
      return { ...call, title: cut(call.path, TITLE_CHARS) };
    case 'search':
      return { ...call, title: cut(call.pattern, TITLE_CHARS) };
    case 'mcp':
      return { ...call, title: cut(`${call.server}.${call.tool}`, TITLE_CHARS) };
    case 'subagent':
      return { ...call, title: cut(call.agent, TITLE_CHARS) };
    case 'web':
      return { ...call, title: cut(call.query ?? call.url ?? call.harnessTool, TITLE_CHARS) };
    case 'other':
      return { ...call, title: cut(call.name, TITLE_CHARS) };
  }
}

/** What a tool call aims at and writes, for the live line and the files a turn touched. */
export function toolCallTarget(call: ToolCallView): ToolTarget {
  const name = call.harnessTool;
  switch (call.kind) {
    case 'command':
      return { name, target: firstWord(call.command), written: [] };
    case 'edit':
      return {
        name,
        target: cut(call.path, TARGET_CHARS),
        written: call.movePath === null ? [call.path] : [call.path, call.movePath],
      };
    case 'read':
      return { name, target: cut(call.path, TARGET_CHARS), written: [] };
    case 'search':
      return { name, target: cut(call.pattern, TARGET_CHARS), written: [] };
    case 'web': {
      const aimed = call.url ?? call.query;
      return { name, target: aimed === null ? null : cut(aimed, TARGET_CHARS), written: [] };
    }
    case 'mcp':
    case 'subagent':
    case 'other':
      return { name, target: null, written: [] };
  }
}

/** The live line's summary and target for a tool call. */
export function toolCallActivity(call: ToolCallView): {
  readonly summary: string;
  readonly tool: ToolTarget;
} {
  return {
    summary: cut(`${call.harnessTool} ${call.title}`, SUMMARY_CHARS),
    tool: toolCallTarget(call),
  };
}
