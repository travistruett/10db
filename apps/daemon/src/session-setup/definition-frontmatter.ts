import { isAlias, isMap, isScalar, parseAllDocuments, stringify, visit, type Document } from 'yaml';
import { z } from 'zod';

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

/** Claude Code's own frontmatter split (2.1.302): an opening `---` line, then up to the first `---`. */
const CLAUDE_CODE_FRONTMATTER = /^---\s*\n([\s\S]*?)---\s*\n?/;
const OPENS_FRONTMATTER = /^---\s*\n/;

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

function holdsAlias(doc: Document): boolean {
  const seen = { alias: false };
  visit(doc, {
    Alias: () => {
      seen.alias = true;
      return visit.BREAK;
    },
  });
  return seen.alias;
}

type Kept = { kept: Record<string, unknown>; dropped: string[] } | { refused: string };

/**
 * The block's allowed keys in their written order, or why the block is refused. A key is looked up among
 * the kind's own keys only, so `constructor` or `__proto__` is an unknown key like any other, and any
 * throw from reading lane-written YAML (a stack exhausted by nesting) refuses the block.
 */
function keptKeys(kind: DefinitionKind, block: string): Kept {
  try {
    return readKeys(kind, block);
  } catch {
    return { refused: 'its frontmatter is not YAML 10db reads' };
  }
}

function readKeys(kind: DefinitionKind, block: string): Kept {
  const docs = parseAllDocuments(block, { uniqueKeys: true });
  if (!Array.isArray(docs)) return { kept: {}, dropped: [] };
  if (docs.length > 1) return { refused: 'its frontmatter holds more than one document' };
  const doc = docs[0];
  if (doc === undefined) return { kept: {}, dropped: [] };
  if (doc.errors.length > 0) return { refused: 'its frontmatter is not YAML 10db reads' };
  if (holdsAlias(doc)) return { refused: 'its frontmatter uses an alias' };
  if (doc.contents === null) return { kept: {}, dropped: [] };
  if (!isMap(doc.contents)) return { refused: 'its frontmatter is not a table' };
  const allowed = new Map<string, z.ZodType>(Object.entries(FRONTMATTER_ALLOWED[kind]));
  const values = z.record(z.string(), z.unknown()).safeParse(doc.toJS({ maxAliasCount: 0 }));
  if (!values.success) return { refused: 'its frontmatter is not a table' };
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const pair of doc.contents.items) {
    const key = pair.key;
    if (isAlias(key) || !isScalar(key) || typeof key.value !== 'string')
      return { refused: 'its frontmatter has a key that is not text' };
    const name = key.value;
    const schema = allowed.get(name);
    if (schema === undefined) {
      dropped.push(name);
      continue;
    }
    const parsed = schema.safeParse(values.data[name]);
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
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  let kept: Record<string, unknown> = {};
  let dropped: string[] = [];
  let rawBody = source;
  const match = CLAUDE_CODE_FRONTMATTER.exec(source);
  if (match) {
    const keys = keptKeys(kind, match[1] ?? '');
    if ('refused' in keys) return keys;
    ({ kept, dropped } = keys);
    rawBody = source.slice(match[0].length);
  } else if (OPENS_FRONTMATTER.test(source)) {
    return { refused: 'its frontmatter has no end' };
  }
  const shell = dropShellLines(rawBody);
  if (shell.count > 0) dropped.push(shellLines(shell.count));
  // Claude Code reads past the closing line's whitespace itself; a body that then opens another block
  // would, with no frontmatter kept, become frontmatter.
  const body = match ? shell.body.trimStart() : shell.body;
  if (body.trimStart().startsWith('---'))
    return {
      refused: match
        ? 'its body starts with another --- block'
        : 'its frontmatter does not start the file',
    };
  if (Object.keys(kept).length === 0) return { text: body, dropped };
  const yaml = stringify(kept);
  const out = `---\n${yaml}---\n${body}`;
  const readBack = CLAUDE_CODE_FRONTMATTER.exec(out);
  if (readBack?.[1] !== yaml || out.slice(readBack[0].length) !== body)
    return { refused: 'its frontmatter would not read back as written' };
  return { text: out, dropped };
}
