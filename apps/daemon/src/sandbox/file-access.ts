import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  foldPathCase,
  isOverLongPath,
  OVER_LONG_PATH_REFUSAL,
  PathResolutionError,
  realPathOf,
  stringField,
  type FileAccessJudge,
} from '../guard';
import { globPatternBases } from './glob-bases';
import { isEqualOrUnder, pathsEqual } from './protected-reads';

export interface FileAccessContext {
  readonly checkout: string;
  readonly home: string;
  readonly protectedReads: readonly string[];
  /** The checkout's secret files by exact real path; unlike protected reads, a search over their directory is not refused. */
  readonly secretFiles?: readonly string[];
  readonly readList: readonly string[];
  /** Claude Code's config directory, where it keeps each session's tool results. */
  readonly configDir: string;
  /** The id Claude Code knows the session by; null until a start or resume names it. */
  readonly providerSessionId: string | null;
  /**
   * Where every sandbox's temp dirs and sealed files are, and this session's own temp dir. Everything
   * else there is another session's or server's, so it is protected.
   */
  readonly sandboxTemp: { readonly root: string; readonly own: string };
}

/** `contains-protected` is a directory-scoped read of a path that has a protected path under it. */
export type ReadAccess = 'inside' | 'allowed' | 'protected' | 'contains-protected' | 'ask';
/** `unresolvable` is a path that no single real path can be named for (a link loop, `..` past a missing part, a part that cannot be examined). */
/** `sandbox-temp` is under the sandbox temp root but outside this session's own temp dir. */
export type WriteAccess =
  'ok' | 'git-internal' | 'claude-protected' | 'sandbox-temp' | 'unresolvable';

/** A file-tool judgment that could not be made; the judge refuses the call. */
export class FileAccessError extends Error {
  override readonly name = 'FileAccessError';
}

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

/** The checkout's Claude-protected paths under `checkout`: files by exact path, directories with their trees. */
export function claudeProtectedPaths(checkout: string): { files: string[]; directories: string[] } {
  return {
    files: CLAUDE_PROTECTED_IN_CHECKOUT.map((path) => join(checkout, path)),
    directories: CLAUDE_PROTECTED_DIRECTORIES.map((path) => join(checkout, path)),
  };
}

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
 * The real path of a tool input's path. Only a missing tail is resolved without the file system;
 * anything else that stops the resolution (a part that cannot be examined, a part that is not a
 * directory, a `..` past a missing part, a link loop) throws a `PathResolutionError`.
 */
function strictRealPath(p: string): string {
  try {
    return realPathOf(p);
  } catch (error) {
    if (error instanceof PathResolutionError) throw error;
    throw new PathResolutionError(`${p} cannot be examined`, { cause: error });
  }
}

/**
 * The real paths a tool input could name: the text read lexically, and as the kernel reads it.
 * Throws a `PathResolutionError` when either reading has no single real path.
 */
function candidates(path: string, ctx: FileAccessContext): string[] {
  const lexical = strictRealPath(plainPath(path, ctx));
  const raw = expandHome(path, ctx.home);
  const kernel = strictRealPath(isAbsolute(raw) ? raw : `${ctx.checkout}${sep}${raw}`);
  return pathsEqual(kernel, lexical) ? [lexical] : [lexical, kernel];
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
function isOwnToolResult(realPath: string, ctx: FileAccessContext): boolean {
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
  if ((ctx.secretFiles ?? []).some((file) => pathsEqual(real, file))) return 'protected';
  const ownTemp = spellings(ctx.sandboxTemp.own).some((dir) => isEqualOrUnder(real, dir));
  const roots = [...ctx.protectedReads, ...(ownTemp ? [] : [ctx.sandboxTemp.root])].flatMap(
    spellings,
  );
  if (roots.some((root) => isEqualOrUnder(real, root))) return 'protected';
  if (tree && roots.some((root) => isEqualOrUnder(root, real))) return 'contains-protected';
  if (spellings(ctx.checkout).some((root) => isEqualOrUnder(real, root))) return 'inside';
  if (ctx.readList.flatMap(spellings).some((root) => isEqualOrUnder(real, root))) return 'allowed';
  return 'ask';
}

/**
 * Judges a path a file tool would read, on the real path it names. A path with `..` after a link
 * is judged both ways and the stricter verdict wins; one that cannot be resolved exactly is
 * `protected`. With `tree` set the path is searched or listed as a directory, so one that holds a
 * protected path is refused too.
 */
export function readAccess(
  path: string,
  ctx: FileAccessContext,
  tree = false,
): { access: ReadAccess; realPath: string } {
  let best: { access: ReadAccess; realPath: string } | null = null;
  let reals: string[];
  try {
    reals = candidates(path, ctx);
  } catch (error) {
    if (error instanceof PathResolutionError) {
      return { access: 'protected', realPath: plainPath(path, ctx) };
    }
    throw error;
  }
  for (const real of reals) {
    const access = judgeRead(real, ctx, tree);
    if (best === null || READ_STRICTNESS[access] > READ_STRICTNESS[best.access]) {
      best = { access, realPath: real };
    }
  }
  return best ?? { access: 'ask', realPath: plainPath(path, ctx) };
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
      return [base, ...globPatternBases(stringField(input, 'pattern') ?? '', base)];
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
  'sandbox-temp': 4,
  unresolvable: 4,
};

function judgeWrite(real: string, ctx: FileAccessContext): WriteAccess {
  if (spellings(ctx.checkout).some((root) => isEqualOrUnder(real, join(root, '.git')))) {
    return 'git-internal';
  }
  // Other sessions' temp dirs and the process ledgers are there: a ledger a lane wrote would name
  // what the next daemon start signals.
  const ownTemp = spellings(ctx.sandboxTemp.own).some((dir) => isEqualOrUnder(real, dir));
  if (!ownTemp && spellings(ctx.sandboxTemp.root).some((root) => isEqualOrUnder(real, root))) {
    return 'sandbox-temp';
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
  let reals: string[];
  try {
    reals = candidates(path, ctx);
  } catch (error) {
    if (error instanceof PathResolutionError) {
      return { access: 'unresolvable', realPath: plainPath(path, ctx), viaLink: false };
    }
    throw error;
  }
  for (const real of reals) {
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
      let path = toolName;
      try {
        for (path of readPathsOf(toolName, input)) {
          if (isOverLongPath(path)) return { refuse: OVER_LONG_PATH_REFUSAL };
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
      } catch (error) {
        return { refuse: refusalFor(path, error) };
      }
    },
    readAsk(toolName, input) {
      try {
        for (const path of readPathsOf(toolName, input)) {
          if (readAccess(path, ctx, toolName !== 'Read').access === 'ask') {
            return `${path} is outside the paths a lane may read without asking.`;
          }
        }
        return null;
      } catch {
        return `${toolName} could not be judged.`;
      }
    },
    writeAsk(path) {
      try {
        return writeAccess(path, ctx).access === 'claude-protected'
          ? `${path} is a Claude Code configuration path.`
          : null;
      } catch {
        return `${path} could not be judged.`;
      }
    },
    write(path) {
      if (isOverLongPath(path)) return { refuse: OVER_LONG_PATH_REFUSAL };
      try {
        const result = writeAccess(path, ctx);
        if (result.access === 'git-internal') {
          return { refuse: '.git/ internals are never edited; use the commit tool.' };
        }
        if (result.access === 'sandbox-temp') {
          return {
            refuse: `${path} is in 10db's sandbox temp root, outside this session's temp dir; 10db never lets a lane write there.`,
          };
        }
        if (result.access === 'unresolvable') {
          return { refuse: `${path} cannot be resolved to one real path; 10db refuses it.` };
        }
        if (result.access === 'claude-protected' && result.viaLink) {
          return { refuse: `Edit ${result.realPath} by its own path, not through a link.` };
        }
        return 'ok';
      } catch (error) {
        return { refuse: refusalFor(path, error) };
      }
    },
  };
}

/** An unexpected failure while judging is a refusal, never an error thrown into the hook. */
function refusalFor(path: string, cause: unknown): string {
  return new FileAccessError(`${path} could not be judged; 10db refuses it.`, { cause }).message;
}
