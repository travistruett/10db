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
