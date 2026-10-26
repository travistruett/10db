import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/**
 * Where the kernel would open `path`: each component is resolved through links as it is met, and a
 * `..` applies to the directory reached so far, not to the text before it. Null when a component
 * cannot be examined.
 */
function kernelPath(path: string, ctx: FileAccessContext): string | null {
  const raw = expandHome(path, ctx.home);
  let current = isAbsolute(raw) ? sep : tryRealPath(ctx.checkout);
  if (current === null) return null;
  for (const part of raw.split(sep)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = tryRealPath(join(current, part));
    if (next === null) return null;
    current = next;
  }
  return current;
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

const CLIMBS_AFTER_GLOB = /(^|[/{,])\.\.([/},]|$)/;

/**
 * The directories a glob pattern names before its first glob character, joined onto `base`. A
 * pattern whose prefix says nothing about where it reaches (it opens with `{`, or climbs with `..`
 * after a glob character) is judged as the root.
 */
function patternPaths(pattern: string, base: string): string[] {
  const wild = pattern.search(GLOB_CHARACTERS);
  if (wild === -1)
    return pattern === '' ? [] : [isAbsolute(pattern) ? pattern : join(base, pattern)];
  if (pattern.replace(/^\//, '').startsWith('{') || CLIMBS_AFTER_GLOB.test(pattern.slice(wild))) {
    return [sep];
  }
  const cut = pattern.lastIndexOf('/', wild);
  if (cut === -1) return [];
  const literal = cut === 0 ? sep : pattern.slice(0, cut);
  return [isAbsolute(literal) ? literal : join(base, literal)];
}

/** The paths a read-side tool would open, as the tool's input spells them. */
export function readPathsOf(toolName: string, input: unknown): string[] {
  switch (toolName) {
    case 'Read': {
      const file = stringField(input, 'file_path');
      return file === null ? [] : [file];
    }
    case 'Grep': {
      const base = stringField(input, 'path') ?? '.';
      return [base, ...patternPaths(stringField(input, 'glob') ?? '', base)];
    }
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
  'claude-protected': 1,
  'git-internal': 2,
};

function judgeWrite(real: string, ctx: FileAccessContext): WriteAccess {
  if (spellings(ctx.checkout).some((root) => isEqualOrUnder(real, join(root, '.git')))) {
    return 'git-internal';
  }
  return isClaudeProtected(real, ctx) ? 'claude-protected' : 'ok';
}

/**
 * Judges a path a file tool would write, on the real path it names. A path with `..` after a link
 * is judged both ways and the stricter verdict wins.
 */
export function writeAccess(
  path: string,
  ctx: FileAccessContext,
): { access: WriteAccess; realPath: string; viaLink: boolean } {
  const baseline = withoutLinks(plainPath(path, ctx), ctx);
  let best: { access: WriteAccess; realPath: string } | null = null;
  for (const real of candidates(path, ctx)) {
    const access = judgeWrite(real, ctx);
    if (best === null || WRITE_STRICTNESS[access] > WRITE_STRICTNESS[best.access]) {
      best = { access, realPath: real };
    }
  }
  const chosen = best ?? { access: 'ok' as const, realPath: plainPath(path, ctx) };
  return { ...chosen, viaLink: !pathsEqual(chosen.realPath, baseline) };
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
