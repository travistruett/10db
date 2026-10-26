import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { foldPathCase, realPathOf, stringField, type FileAccessJudge } from '../guard';
import { isEqualOrUnder, pathsEqual } from './protected-reads';

export interface FileAccessContext {
  readonly checkout: string;
  readonly home: string;
  readonly protectedReads: readonly string[];
  readonly readList: readonly string[];
  /** Claude Code's config directory, where it keeps each session's tool results. */
  readonly configDir: string;
  /** The id Claude Code knows the session by; null until a start or resume names it. */
  readonly providerSessionId: string | null;
}

/** `contains-protected` is a directory-scoped read of a path that has a protected path under it. */
export type ReadAccess = 'inside' | 'allowed' | 'protected' | 'contains-protected' | 'ask';
export type WriteAccess = 'ok' | 'git-internal' | 'claude-protected';

const GLOB_CHARACTERS = /[*?[{]/;

const CLAUDE_PROTECTED_IN_CHECKOUT = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
];
const CLAUDE_PROTECTED_DIRECTORIES = [
  '.claude/hooks',
  '.claude/skills',
  '.claude/agents',
  '.claude/commands',
  '.vscode',
  '.idea',
];
const CLAUDE_PROTECTED_IN_HOME = [
  '.zshrc',
  '.zprofile',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.gitconfig',
];

/** The real path of `p`, or null when a component cannot be examined. */
function tryRealPath(p: string): string | null {
  try {
    return realPathOf(p);
  } catch {
    return null;
  }
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

function plainPath(path: string, ctx: FileAccessContext): string {
  return resolve(ctx.checkout, expandHome(path, ctx.home));
}

/** Where the kernel would open `path`: links resolve as they are met, and `..` follows them. */
function kernelPath(path: string, ctx: FileAccessContext): string | null {
  const raw = expandHome(path, ctx.home);
  return tryRealPath(isAbsolute(raw) ? raw : `${ctx.checkout}${sep}${raw}`);
}

/** The real paths a tool input could name: the text read lexically, and as the kernel reads it. */
function candidates(path: string, ctx: FileAccessContext): string[] {
  const plain = plainPath(path, ctx);
  const lexical = tryRealPath(plain) ?? plain;
  const kernel = kernelPath(path, ctx);
  return kernel === null || pathsEqual(kernel, lexical) ? [lexical] : [lexical, kernel];
}

/** Both spellings of a root: as given and with its links resolved. */
function spellings(root: string): string[] {
  const real = tryRealPath(root);
  return real === null || real === root ? [root] : [root, real];
}

/**
 * True only for a file under this session's own `tool-results` directory in Claude Code's config:
 * `<configDir>/projects/<slug>/<providerSessionId>/tool-results/<file>`.
 */
export function isOwnToolResult(realPath: string, ctx: FileAccessContext): boolean {
  if (ctx.providerSessionId === null) return false;
  const sessionId = foldPathCase(ctx.providerSessionId);
  for (const config of spellings(ctx.configDir)) {
    const projects = foldPathCase(join(config, 'projects'));
    const folded = foldPathCase(realPath);
    if (!folded.startsWith(`${projects}/`)) continue;
    const parts = folded.slice(projects.length + 1).split('/');
    const [slug, id, tool, ...rest] = parts;
    if (slug && id === sessionId && tool === 'tool-results' && rest.some((p) => p !== '')) {
      return true;
    }
  }
  return false;
}

const READ_STRICTNESS: Record<ReadAccess, number> = {
  inside: 0,
  allowed: 1,
  ask: 2,
  protected: 3,
  'contains-protected': 3,
};

function judgeRead(real: string, ctx: FileAccessContext, tree: boolean): ReadAccess {
  if (isOwnToolResult(real, ctx)) return 'allowed';
  const roots = ctx.protectedReads.flatMap(spellings);
  if (roots.some((root) => isEqualOrUnder(real, root))) return 'protected';
  if (tree && roots.some((root) => isEqualOrUnder(root, real))) return 'contains-protected';
  if (spellings(ctx.checkout).some((root) => isEqualOrUnder(real, root))) return 'inside';
  if (ctx.readList.flatMap(spellings).some((root) => isEqualOrUnder(real, root))) return 'allowed';
  return 'ask';
}

/**
 * Judges a path a file tool would read, on the real path it names. A path with `..` after a link
 * is judged both ways and the stricter verdict wins. With `tree` set the path is searched or
 * listed as a directory, so one that holds a protected path is refused too.
 */
export function readAccess(
  path: string,
  ctx: FileAccessContext,
  tree = false,
): { access: ReadAccess; realPath: string } {
  let best: { access: ReadAccess; realPath: string } | null = null;
  for (const real of candidates(path, ctx)) {
    const access = tryRealPath(real) === null ? 'ask' : judgeRead(real, ctx, tree);
    if (best === null || READ_STRICTNESS[access] > READ_STRICTNESS[best.access]) {
      best = { access, realPath: real };
    }
  }
  return best ?? { access: 'ask', realPath: plainPath(path, ctx) };
}

const CLIMBS_AFTER_GLOB = /(^|\/)\.\.(\/|$)/;
const MAX_BRACE_ALTERNATIVES = 64;

/** Splits `text` at the commas that are not inside a nested brace. */
function topLevelAlternatives(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Expands the braces of a glob pattern, nested ones included. Null when a brace is unbalanced or
 * the pattern has more than `MAX_BRACE_ALTERNATIVES` alternatives.
 */
function expandBraces(pattern: string): string[] | null {
  const open = pattern.indexOf('{');
  if (open === -1) return pattern.includes('}') ? null : [pattern];
  let depth = 0;
  let close = -1;
  for (let index = open; index < pattern.length && close === -1; index += 1) {
    if (pattern[index] === '{') depth += 1;
    else if (pattern[index] === '}') {
      depth -= 1;
      if (depth === 0) close = index;
    }
  }
  if (close === -1) return null;
  const before = pattern.slice(0, open);
  const after = pattern.slice(close + 1);
  const expanded: string[] = [];
  for (const alternative of topLevelAlternatives(pattern.slice(open + 1, close))) {
    const rest = expandBraces(`${before}${alternative}${after}`);
    if (rest === null) return null;
    expanded.push(...rest);
    if (expanded.length > MAX_BRACE_ALTERNATIVES) return null;
  }
  return expanded;
}

function underBase(base: string, literal: string): string {
  if (isAbsolute(literal)) return literal;
  return base === '.' ? literal : `${base}${sep}${literal}`;
}

/** The directory one brace-free pattern names before its first glob character. */
function patternPrefix(pattern: string, base: string): string | null {
  const wild = pattern.search(GLOB_CHARACTERS);
  if (wild === -1) return pattern === '' ? null : underBase(base, pattern);
  if (CLIMBS_AFTER_GLOB.test(pattern.slice(wild))) return sep;
  const cut = pattern.lastIndexOf('/', wild);
  if (cut === -1) return null;
  return cut === 0 ? sep : underBase(base, pattern.slice(0, cut));
}

/**
 * The directories a glob pattern reaches, joined onto `base`: every brace alternative is judged by
 * its literal prefix. A pattern that cannot be judged by its prefix (an unbalanced brace, too many
 * alternatives, a `..` after a glob character) is judged as the root.
 */
function patternPaths(pattern: string, base: string): string[] {
  const alternatives = expandBraces(pattern);
  if (alternatives === null) return [sep];
  const prefixes = alternatives.map((alternative) => patternPrefix(alternative, base));
  return [...new Set(prefixes.filter((prefix) => prefix !== null))];
}

/** The paths a read-side tool would open, as the tool's input spells them. */
export function readPathsOf(toolName: string, input: unknown): string[] {
  switch (toolName) {
    case 'Read': {
      const file = stringField(input, 'file_path');
      return file === null ? [] : [file];
    }
    case 'Grep':
    case 'LS':
      return [stringField(input, 'path') ?? '.'];
    case 'Glob': {
      const base = stringField(input, 'path') ?? '.';
      return [base, ...patternPaths(stringField(input, 'pattern') ?? '', base)];
    }
    default:
      return [];
  }
}

/** Where a plain path would land if no link redirected it, with the checkout's own links resolved. */
function withoutLinks(plain: string, ctx: FileAccessContext): string {
  const realCheckout = tryRealPath(ctx.checkout);
  const rel = relative(ctx.checkout, plain);
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  return realCheckout !== null && inside ? join(realCheckout, rel) : plain;
}

function isClaudeProtected(real: string, ctx: FileAccessContext): boolean {
  for (const root of spellings(ctx.checkout)) {
    if (CLAUDE_PROTECTED_IN_CHECKOUT.some((p) => pathsEqual(real, join(root, p)))) return true;
    if (CLAUDE_PROTECTED_DIRECTORIES.some((p) => isEqualOrUnder(real, join(root, p)))) return true;
  }
  return spellings(ctx.home).some((home) =>
    CLAUDE_PROTECTED_IN_HOME.some((name) => pathsEqual(real, join(home, name))),
  );
}

const WRITE_STRICTNESS: Record<WriteAccess, number> = {
  ok: 0,
  'claude-protected': 2,
  'git-internal': 4,
};

function judgeWrite(real: string, ctx: FileAccessContext): WriteAccess {
  if (spellings(ctx.checkout).some((root) => isEqualOrUnder(real, join(root, '.git')))) {
    return 'git-internal';
  }
  return isClaudeProtected(real, ctx) ? 'claude-protected' : 'ok';
}

/**
 * Judges a path a file tool would write, on the real path it names. A path with `..` after a link
 * is judged both ways and the stricter verdict wins; a Claude-protected reading reached through a
 * link outranks one that is not, since that is the one the judge refuses.
 */
export function writeAccess(
  path: string,
  ctx: FileAccessContext,
): { access: WriteAccess; realPath: string; viaLink: boolean } {
  const baseline = withoutLinks(plainPath(path, ctx), ctx);
  let best: { access: WriteAccess; realPath: string; viaLink: boolean; rank: number } | null = null;
  for (const real of candidates(path, ctx)) {
    const access = judgeWrite(real, ctx);
    const viaLink = !pathsEqual(real, baseline);
    const rank = WRITE_STRICTNESS[access] + (access === 'claude-protected' && viaLink ? 1 : 0);
    if (best === null || rank > best.rank) best = { access, realPath: real, viaLink, rank };
  }
  if (best === null) return { access: 'ok', realPath: plainPath(path, ctx), viaLink: false };
  return { access: best.access, realPath: best.realPath, viaLink: best.viaLink };
}

/** The guard's file-access judge for one lane: protected reads and git internals are refused by real path. */
export function fileAccessJudge(ctx: FileAccessContext): FileAccessJudge {
  return {
    read(toolName, input) {
      for (const path of readPathsOf(toolName, input)) {
        const { access } = readAccess(path, ctx, toolName !== 'Read');
        if (access === 'protected') {
          return { refuse: `${path} is a protected path; 10db never lets a lane read it.` };
        }
        if (access === 'contains-protected') {
          return {
            refuse: `${path} contains protected paths; 10db never lets a lane search or list it.`,
          };
        }
      }
      return 'ok';
    },
    write(path) {
      const result = writeAccess(path, ctx);
      if (result.access === 'git-internal') {
        return { refuse: '.git/ internals are never edited; use the commit tool.' };
      }
      if (result.access === 'claude-protected' && result.viaLink) {
        return { refuse: `Edit ${result.realPath} by its own path, not through a link.` };
      }
      return 'ok';
    },
  };
}
