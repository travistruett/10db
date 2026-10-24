import {
  isCommandRunner,
  packageToolProgramIndex,
  ToolAccess,
  type PermissionRuleDto,
  type ProjectDto,
} from '@10db/contracts';
import { join } from 'node:path';
import { z } from 'zod';
import {
  READ_COMMANDS,
  resolveInRepo,
  splitCommand,
  stringField,
  stripCommandPrefixes,
} from '../guard';
import { isLiteralSegment, plainSegments, type PlainSegment } from './plain-segments';

/** Allow rules injected into every managed session. The guard still checks claims. */
export function baseAllowedTools(project: Pick<ProjectDto, 'gateCommand'>): string[] {
  return [
    'Read',
    'Glob',
    'Grep',
    'LS',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    'TodoWrite',
    'mcp__10db__*',
    `Bash(${project.gateCommand})`,
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git show:*)',
    'Bash(pwd)',
  ];
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * A read-only step drops the file-writing tools and the gate, and may run the read
 * commands without a card; the guard has already refused anything that writes.
 * An edit step also runs the project's extra allowed commands without a card. Each is a prefix,
 * so `pnpm test` covers `pnpm test --run`; the guard still judges every command first.
 */
export function allowedToolsFor(
  project: Pick<ProjectDto, 'gateCommand' | 'allowedCommands'>,
  tools: ToolAccess,
): string[] {
  const base = baseAllowedTools(project);
  if (tools === ToolAccess.Edit)
    return [...base, ...project.allowedCommands.map((command) => `Bash(${command}:*)`)];
  const gate = `Bash(${project.gateCommand})`;
  return [
    ...base.filter((t) => !WRITE_TOOLS.has(t) && t !== gate),
    ...[...READ_COMMANDS].map((c) => `Bash(${c}:*)`),
  ];
}

const ToolInput = z.record(z.string(), z.unknown());
/** Tools that only read; the base allow covers them inside the repository. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
/** Input fields of the read tools that name a place on disk. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'pattern'];

function startsWithWords(line: string, prefix: string): boolean {
  return line === prefix || line.startsWith(`${prefix} `);
}

function segmentKey(segment: PlainSegment): string {
  return `${segment.line}\u0000${segment.separator}`;
}

function bashEntryMatches(entry: string, segments: readonly PlainSegment[]): boolean {
  const rule = /^Bash\((.+)\)$/.exec(entry)?.[1];
  if (rule === undefined) return false;
  if (rule.endsWith(':*')) {
    const prefix = rule.slice(0, -2);
    return segments.every((s) => startsWithWords(s.line, prefix));
  }
  const expected = plainSegments(rule);
  return (
    expected !== null &&
    expected.length === segments.length &&
    expected.every((e, i) => segmentKey(e) === segmentKey(segments[i] ?? e))
  );
}

/** The repository root itself resolves as outside, so a child probe stands in for it. */
function inRepoOrIsRepo(repoPath: string, value: string): boolean {
  return resolveInRepo(repoPath, value).inside || resolveInRepo(repoPath, join(value, '_')).inside;
}

/** Whether every path a read tool names resolves inside the repository; no path means the repository. */
function readsInsideRepo(input: unknown, repoPath: string): boolean {
  const parsed = ToolInput.safeParse(input);
  if (!parsed.success) return false;
  return PATH_FIELDS.every((field) => {
    const value = parsed.data[field];
    if (value === undefined) return true;
    if (typeof value !== 'string') return false;
    return !value.startsWith('~') && inRepoOrIsRepo(repoPath, value);
  });
}

function mcpEntryMatches(entry: string, toolName: string): boolean {
  const server = entry.slice('mcp__'.length, -'__*'.length);
  const [prefix, name, ...tool] = toolName.split('__');
  const toolPart = tool.join('__');
  return prefix === 'mcp' && name === server && /^[A-Za-z0-9]/.test(toolPart);
}

/**
 * Whether an allow-list entry (`Name`, `prefix*`, `mcp__server__*`, `Bash(cmd)`, `Bash(prefix:*)`)
 * permits the call. A Bash entry covers only plain segments, and every segment must be covered.
 */
export function matchesAllowedTool(
  toolName: string,
  input: unknown,
  allowed: readonly string[],
  repoPath: string,
): boolean {
  if (toolName === 'Bash') {
    const command = stringField(input, 'command');
    const segments = command === null ? null : plainSegments(command);
    if (segments === null) return false;
    return (
      allowed.some((entry) => bashEntryMatches(entry, segments)) ||
      segments.every((segment) => allowed.some((entry) => bashEntryMatches(entry, [segment])))
    );
  }
  return allowed.some((entry) => {
    if (entry.startsWith('Bash(')) return false;
    if (READ_TOOLS.has(toolName) && entry === toolName) return readsInsideRepo(input, repoPath);
    if (entry.startsWith('mcp__') && entry.endsWith('__*')) return mcpEntryMatches(entry, toolName);
    return entry.endsWith('*') ? toolName.startsWith(entry.slice(0, -1)) : toolName === entry;
  });
}

/** Bun runs the file it names as well as a package, so every bun command keeps its whole words. */
const FILE_RUNNERS: ReadonlySet<string> = new Set(['bun']);
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Whether the words run another program, so "always allow" keeps them whole. The package tools that
 * name a program come from @10db/contracts, the same list allowed-commands reads. Names are compared
 * without case: a case-insensitive file system runs `PNPM` as `pnpm`.
 */
function runsOtherCommands(words: readonly string[]): boolean {
  const [first = ''] = words;
  const name = first.toLowerCase();
  return isCommandRunner(name) || FILE_RUNNERS.has(name) || packageToolProgramIndex(words) !== null;
}

/**
 * The pattern stored by "always allow": the program plus its subcommand when the second word is
 * one, otherwise the segment's whole words, so the rule never covers more than what was shown.
 * Null when the command has a substitution, expansion or redirection, or runs through a wrapper
 * with a command-carrying flag: such a command can only be allowed once.
 */
export function commandPrefix(command: string): string | null {
  const segments = splitCommand(command);
  const first = segments[0];
  if (first === undefined || !segments.every(isLiteralSegment)) return null;
  const words = stripCommandPrefixes(first.words);
  const [head, second] = words;
  if (head === undefined) return null;
  if (second === undefined) return head;
  if (!runsOtherCommands(words) && SUBCOMMAND.test(second)) return `${head} ${second}`;
  return words.join(' ');
}

/** The stored rule that permits the call, if any; a Bash pattern must cover every plain segment. */
export function matchPermissionRule(
  req: { readonly toolName: string; readonly input: unknown },
  rules: readonly PermissionRuleDto[],
): PermissionRuleDto | undefined {
  return rules.find((rule) => {
    if (rule.toolName !== req.toolName) return false;
    if (req.toolName !== 'Bash') return rule.pattern === null;
    const pattern = rule.pattern;
    if (pattern === null) return false;
    const command = stringField(req.input, 'command');
    const segments = command === null ? null : plainSegments(command);
    return segments?.every((s) => startsWithWords(s.line, pattern)) === true;
  });
}
