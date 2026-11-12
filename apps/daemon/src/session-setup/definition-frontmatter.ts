import { z } from 'zod';
import { readFrontmatter, writeFrontmatter } from '../sandbox';

export const DefinitionKind = { Skill: 'skill', Command: 'command', Agent: 'agent' } as const;
export type DefinitionKind = (typeof DefinitionKind)[keyof typeof DefinitionKind];

const Text = z.string();
const Flag = z.boolean();
const TextOrList = z.union([z.string(), z.array(z.string())]);

/**
 * The frontmatter keys a lane-written definition keeps: only those that describe or narrow it. Every other
 * key (`hooks`, `mcpServers`, `permissionMode`, `allowed-tools`, `model`, `context`, `agent`, `isolation`,
 * `skills`, `shell`, anything unknown) is dropped. An agent keeps `tools`, because without it the subagent
 * would inherit every tool.
 */
export const FRONTMATTER_ALLOWED = {
  [DefinitionKind.Skill]: {
    name: Text,
    description: Text,
    when_to_use: Text,
    'argument-hint': TextOrList,
    'user-invocable': Flag,
    'disable-model-invocation': Flag,
    license: Text,
    version: Text,
  },
  [DefinitionKind.Command]: {
    description: Text,
    'argument-hint': TextOrList,
    'disable-model-invocation': Flag,
  },
  [DefinitionKind.Agent]: {
    name: Text,
    description: Text,
    tools: TextOrList,
    disallowedTools: TextOrList,
    color: Text,
  },
} as const satisfies Record<DefinitionKind, Record<string, z.ZodType>>;

/**
 * What Claude Code runs when it expands a definition: an inline `` !`…` `` and a fenced block opened by
 * ```` ```! ````. Neither pattern spans a line break, so dropping each line that holds one leaves none.
 */
const SHELL_LINE = /!`|```!/;

type Cleaned = { text: string; dropped: string[] } | { refused: string };

function shellLines(count: number): string {
  return `${String(count)} shell line${count === 1 ? '' : 's'}`;
}

function dropShellLines(body: string): { body: string; count: number } {
  const lines = body.split('\n');
  const kept = lines.filter((line) => !SHELL_LINE.test(line));
  return { body: kept.join('\n'), count: lines.length - kept.length };
}

function holdsShell(value: unknown): boolean {
  if (typeof value === 'string') return SHELL_LINE.test(value);
  return Array.isArray(value) && value.some(holdsShell);
}

/** The block's allowed keys in their written order, or why the block is refused. */
function keptKeys(
  kind: DefinitionKind,
  pairs: readonly (readonly [string, unknown])[],
): { kept: Record<string, unknown>; dropped: string[] } | { refused: string } {
  // The kind's own keys only, so `constructor` or `__proto__` is an unknown key like any other.
  const allowed = new Map<string, z.ZodType>(Object.entries(FRONTMATTER_ALLOWED[kind]));
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [name, value] of pairs) {
    const schema = allowed.get(name);
    if (schema === undefined) {
      dropped.push(name);
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      return { refused: `its frontmatter key ${name} is not the type 10db keeps` };
    if (holdsShell(parsed.data))
      return { refused: `its frontmatter key ${name} holds a shell command` };
    kept[name] = parsed.data;
  }
  return { kept, dropped };
}

/**
 * A lane-written skill, command or agent file with only the frontmatter keys its kind allows, re-emitted
 * from the parsed values and never edited as text, and without any line Claude Code would run as a shell
 * command. The result must read back, under Claude Code's own split, as exactly what was emitted.
 */
export function cleanDefinition(kind: DefinitionKind, text: string): Cleaned {
  const split = readFrontmatter(text);
  if ('refused' in split) return split;
  const keys = keptKeys(kind, split.pairs);
  if ('refused' in keys) return keys;
  const { kept, dropped } = keys;
  const shell = dropShellLines(split.body);
  if (shell.count > 0) dropped.push(shellLines(shell.count));
  // Claude Code reads past the closing line's whitespace itself; a body that then opens another block
  // would, with no frontmatter kept, become frontmatter.
  const hasBlock = split.block !== null;
  const body = hasBlock ? shell.body.trimStart() : shell.body;
  if (body.trimStart().startsWith('---'))
    return {
      refused: hasBlock
        ? 'its body starts with another --- block'
        : 'its frontmatter does not start the file',
    };
  const written = writeFrontmatter(kept, body);
  return 'refused' in written ? written : { text: written.text, dropped };
}
