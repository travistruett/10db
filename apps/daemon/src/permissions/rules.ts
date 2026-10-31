import { ToolAccess, type PermissionRuleDto, type ProjectDto } from '@10db/contracts';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  EQUALS_EXPANSION,
  foldPathCase,
  parseShell,
  realPathOf,
  READ_COMMANDS,
  resolveInRepo,
  splitCommand,
  stringField,
  stripCommandPrefixes,
} from '../guard';
import { isSandboxDomain } from '../sandbox';
import { isLiteralSegment, plainSegments, type PlainSegment } from './plain-segments';
import { runsOtherCommands, runsUnnamedProgram } from './runner-forms';

/** Allow rules injected into every managed session. The guard still checks claims. */
export function baseAllowedTools(
  project: Pick<ProjectDto, 'gateCommand'> & Partial<Pick<ProjectDto, 'changedCheckCommand'>>,
): string[] {
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
    ...(project.gateCommand === null ? [] : [`Bash(${project.gateCommand})`]),
    ...(project.changedCheckCommand ? [`Bash(${project.changedCheckCommand})`] : []),
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git show:*)',
    'Bash(pwd)',
  ];
}

/** The sandbox's ask to reach a host; a stored rule for it names the host. */
const NETWORK_TOOL = 'SandboxNetworkAccess';
/** Tools that write a file; a stored rule for one names the real path it may write. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * A read-only step drops the file-writing tools and the gate, and may run the read
 * commands without a card; the guard has already refused anything that writes.
 * An edit step also runs the project's extra allowed commands without a card. Each is a prefix,
 * so `pnpm test` covers `pnpm test --run`; the guard still judges every command first.
 */
export function allowedToolsFor(
  project: Pick<ProjectDto, 'gateCommand' | 'allowedCommands'> &
    Partial<Pick<ProjectDto, 'changedCheckCommand'>>,
  tools: ToolAccess,
  opts: { readonly sandboxed?: { readonly checkout: string } } = {},
): string[] {
  const base = scopedReads(baseAllowedTools(project), opts.sandboxed?.checkout);
  if (tools === ToolAccess.Edit) {
    // An allow rule settles a call before Claude Code's auto-mode classifier sees it, so the exact
    // gate command stays out of a sandboxed lane's list: the classifier's hard deny refuses it.
    const gate = project.gateCommand === null ? null : `Bash(${project.gateCommand})`;
    const check = project.changedCheckCommand ? `Bash(${project.changedCheckCommand})` : null;
    const listed = opts.sandboxed && gate !== check ? base.filter((tool) => tool !== gate) : base;
    return [...listed, ...project.allowedCommands.map((command) => `Bash(${command}:*)`)];
  }
  const gates = [project.gateCommand, project.changedCheckCommand ?? null].flatMap((c) =>
    c ? [`Bash(${c})`] : [],
  );
  return [
    ...base.filter((t) => !WRITE_TOOLS.has(t) && !gates.includes(t)),
    ...[...READ_COMMANDS].map((c) => `Bash(${c}:*)`),
  ];
}

/** The tools that only read; the base allow covers them inside the repository. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);

/**
 * Claude Code's spelling of "this directory and everything under it": `//` stands for the
 * filesystem root, so the absolute path's own leading slash is the second one.
 */
function scopeOf(realCheckout: string): string {
  return `/${realCheckout}/**`;
}

/** The real path of the checkout, as given when it cannot be resolved. */
function realCheckoutOf(checkout: string): string {
  try {
    return realPathOf(checkout);
  } catch {
    return checkout;
  }
}

/**
 * A sandboxed lane may read only its checkout without a card, so each bare read tool becomes an
 * entry scoped to the checkout's real path. Without a checkout the list is unchanged.
 */
function scopedReads(tools: string[], checkout: string | undefined): string[] {
  if (checkout === undefined) return tools;
  const scope = scopeOf(realCheckoutOf(checkout));
  return tools.map((tool) => (READ_TOOLS.has(tool) ? `${tool}(${scope})` : tool));
}

const ToolInput = z.record(z.string(), z.unknown());
/** Input fields of the read tools that name a place on disk. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'pattern'];

/** Whether the segment's words begin with the prefix's words, compared word by word. */
function startsWithWords(words: readonly string[], prefix: string): boolean {
  const parsed = plainSegments(prefix);
  const prefixWords = parsed?.length === 1 ? parsed[0]?.words : undefined;
  if (prefixWords === undefined || prefixWords.length === 0) return false;
  if (prefixWords.join(' ') !== prefix || !prefixWords.every(isPlainWord)) return false;
  return prefixWords.every((word, i) => words[i] === word);
}

function segmentKey(segment: PlainSegment): string {
  return `${JSON.stringify(segment.words)}${segment.separator}`;
}

function bashEntryMatches(entry: string, segments: readonly PlainSegment[]): boolean {
  const rule = /^Bash\((.+)\)$/.exec(entry)?.[1];
  if (rule === undefined) return false;
  if (rule.endsWith(':*')) {
    const prefix = rule.slice(0, -2);
    return segments.every((s) => startsWithWords(s.words, prefix));
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
  return resolveInRepo(repoPath, value).inside || resolveInRepo(repoPath, `${value}/_`).inside;
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

/** `Read(//<dir>/**)` and its Glob, Grep and LS forms: the tool and the directory it is scoped to. */
const SCOPED_READ = /^(Read|Glob|Grep|LS)\(\/(\/.+)\/\*\*\)$/;

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
    const scoped = SCOPED_READ.exec(entry);
    if (scoped !== null) {
      return scoped[1] === toolName && readsInsideRepo(input, scoped[2] ?? '');
    }
    if (entry.startsWith('mcp__') && entry.endsWith('__*')) return mcpEntryMatches(entry, toolName);
    return entry.endsWith('*') ? toolName.startsWith(entry.slice(0, -1)) : toolName === entry;
  });
}

const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * The pattern stored by "always allow": the program plus its subcommand when the second word is
 * one, otherwise the segment's whole words, so the rule never covers more than what was shown.
 * Null when the command has a substitution, expansion or redirection, runs through a wrapper
 * with a command-carrying flag, runs a program it does not name (see runsUnnamedProgram), cannot
 * be parsed with certainty, or the stored words would not read back as the same one segment (a
 * word with whitespace, `#`, `;`, `&&` or a brace): such a command can only be allowed once.
 */
export function commandPrefix(command: string): string | null {
  if (!parseShell(command).certain) return null;
  const segments = splitCommand(command);
  const first = segments[0];
  if (first === undefined || !segments.every(isLiteralSegment)) return null;
  const words = stripCommandPrefixes(first.words, { keepCommandPath: true });
  const [head, second] = words;
  if (head === undefined || runsUnnamedProgram(words)) return null;
  if (second === undefined) return storable(head, words);
  if (!runsOtherCommands(words) && SUBCOMMAND.test(second))
    return storable(`${head} ${second}`, [head, second]);
  return storable(words.join(' '), words);
}

/** Characters whose meaning never depends on quoting; any other word is allowed once only. */
const PLAIN_WORD = /^[A-Za-z0-9._/:@%+=,-]+$/;

/** A word that means the same quoted or not: plain characters and no zsh `=cmd` expansion. */
function isPlainWord(word: string): boolean {
  return PLAIN_WORD.test(word) && !EQUALS_EXPANSION.test(word);
}

/**
 * The pattern when it reads back as one segment of exactly these words. A word that holds
 * whitespace, `#`, `;`, `&&` or a brace changes meaning once the words are joined into text, and a
 * word with `~`, `*`, `?`, `[`, `!` or the like means something else once its quotes are gone.
 */
function storable(pattern: string, words: readonly string[]): string | null {
  if (!words.every(isPlainWord)) return null;
  const parsed = plainSegments(pattern);
  const [only] = parsed ?? [];
  if (parsed?.length !== 1 || only === undefined) return null;
  const same = only.words.length === words.length && only.words.every((w, i) => w === words[i]);
  return same ? pattern : null;
}

/**
 * True when a network rule's pattern covers the host, as the sandbox's `allowedDomains` reads it:
 * `*.crates.io` covers every subdomain of crates.io but not crates.io itself, and never an address;
 * any other pattern covers only its own host.
 */
function hostMatches(host: string, pattern: string): boolean {
  if (!pattern.startsWith('*.')) return host === pattern;
  return isIP(host.replace(/^\[|\]$/g, '')) === 0 && host.endsWith(pattern.slice(1));
}

/**
 * The stored rule that permits the call, if any: a Bash pattern must cover every plain segment, a
 * file rule's pattern every real path in `paths`, and a network rule's pattern the host. A sandboxed
 * lane passes `paths` (empty for a host), and there an unscoped file or network rule matches
 * nothing; without it an unscoped rule allows its tool, as it always has.
 */
export function matchPermissionRule(
  req: { readonly toolName: string; readonly input: unknown },
  rules: readonly PermissionRuleDto[],
  paths?: { readonly realPaths: readonly string[] },
): PermissionRuleDto | undefined {
  return rules.find((rule) => {
    const { pattern } = rule;
    if (req.toolName === NETWORK_TOOL) {
      if (rule.toolName !== req.toolName) return false;
      if (pattern === null) return paths === undefined;
      const host = stringField(req.input, 'host');
      return host !== null && hostMatches(host.toLowerCase(), pattern);
    }
    if (pattern !== null && READ_TOOLS.has(req.toolName)) {
      const real = paths?.realPaths ?? [];
      return (
        rule.toolName === 'Read' &&
        real.length > 0 &&
        real.every((path) => isEqualOrUnder(path, pattern))
      );
    }
    if (rule.toolName !== req.toolName) return false;
    if (req.toolName !== 'Bash') {
      if (pattern === null) {
        // With real paths in hand (a sandboxed lane) an unscoped file rule covers no path.
        const fileTool = READ_TOOLS.has(req.toolName) || WRITE_TOOLS.has(req.toolName);
        return !(paths !== undefined && fileTool);
      }
      const real = paths?.realPaths ?? [];
      return (
        WRITE_TOOLS.has(req.toolName) &&
        real.length === 1 &&
        foldPathCase(real[0] ?? '') === foldPathCase(pattern)
      );
    }
    // A pattern whose words name no program, such as a bare runner, covers nothing, even one stored earlier.
    if (pattern === null || runsUnnamedProgram(pattern.split(' '))) return false;
    const command = stringField(req.input, 'command');
    const segments = command === null ? null : plainSegments(command);
    return segments?.every((s) => startsWithWords(s.words, pattern)) === true;
  });
}

const GLOB_CHARACTER = /[*?[\]{}]/;

/** The rule a card's "allow" choices store, or undefined when the call can only be allowed once. */
export interface StorableRule {
  readonly toolName: string;
  readonly pattern: string | null;
}

/**
 * A host the profile's `allowedDomains` can't list but the broker can still match exactly: a name
 * with an underscore (`my_service`) or an IPv6 address, bare or bracketed. No port, path or space.
 */
const IPV6 = '(?:[0-9a-f]*:){2,}[0-9a-f.]*';
const LITERAL_HOST = new RegExp(`^(?:[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*|${IPV6}|\\[${IPV6}\\])$`);
const MAX_HOST_LENGTH = 253;

function isLiteralHost(host: string): boolean {
  return host.length <= MAX_HOST_LENGTH && LITERAL_HOST.test(host);
}

/**
 * The rule "always allow" stores for a card, from its tool and its canonical summary: the command
 * for Bash, the host for the sandbox's network asks, the real absolute path for the file tools.
 * One approval of any read tool is stored as `Read`, so it covers Grep, Glob and LS of the path
 * too. A path with a glob character or one that is not absolute can only be allowed once.
 */
export function storableRule(toolName: string, summary: string): StorableRule | undefined {
  if (toolName === 'Bash') {
    const pattern = commandPrefix(summary);
    return pattern === null ? undefined : { toolName, pattern };
  }
  if (toolName === NETWORK_TOOL) {
    // A sandboxed lane's summary is the host. Any other summary (the JSON input a lane without the
    // sandbox shows) stores no pattern, as it always has.
    const host = summary.toLowerCase();
    return { toolName, pattern: isSandboxDomain(host) || isLiteralHost(host) ? host : null };
  }
  const reads = READ_TOOLS.has(toolName);
  // An absolute path is a sandboxed lane's summary; any other summary is the unscoped form a lane
  // without the sandbox has always had, which stores no pattern.
  if ((reads || WRITE_TOOLS.has(toolName)) && isAbsolute(summary)) {
    return GLOB_CHARACTER.test(summary)
      ? undefined
      : { toolName: reads ? 'Read' : toolName, pattern: summary };
  }
  return { toolName, pattern: null };
}

/** True when `path` is `root` or lies under it, spelled the way the file system folds case. */
function isEqualOrUnder(path: string, root: string): boolean {
  const p = foldPathCase(path);
  const r = foldPathCase(root);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}
