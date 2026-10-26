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

export type ReadAccess = 'inside' | 'allowed' | 'protected' | 'ask';
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

/** Judges a path a file tool would read, on the real path it names. */
export function readAccess(
  path: string,
  ctx: FileAccessContext,
): { access: ReadAccess; realPath: string } {
  const plain = plainPath(path, ctx);
  const real = tryRealPath(plain);
  if (real === null) return { access: 'ask', realPath: plain };
  if (isOwnToolResult(real, ctx)) return { access: 'allowed', realPath: real };
  const isProtected = ctx.protectedReads
    .flatMap(spellings)
    .some((root) => isEqualOrUnder(real, root));
  if (isProtected) return { access: 'protected', realPath: real };
  if (spellings(ctx.checkout).some((root) => isEqualOrUnder(real, root))) {
    return { access: 'inside', realPath: real };
  }
  if (ctx.readList.flatMap(spellings).some((root) => isEqualOrUnder(real, root))) {
    return { access: 'allowed', realPath: real };
  }
  return { access: 'ask', realPath: real };
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
      const pattern = stringField(input, 'pattern') ?? '';
      const paths = [base];
      const wild = pattern.search(GLOB_CHARACTERS);
      const literal =
        wild === -1 ? pattern : pattern.slice(0, Math.max(0, pattern.lastIndexOf('/', wild)));
      if (literal !== '') paths.push(isAbsolute(literal) ? literal : join(base, literal));
      return paths;
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

/** Judges a path a file tool would write, on the real path it names. */
export function writeAccess(
  path: string,
  ctx: FileAccessContext,
): { access: WriteAccess; realPath: string; viaLink: boolean } {
  const plain = plainPath(path, ctx);
  const real = tryRealPath(plain) ?? plain;
  const viaLink = !pathsEqual(real, withoutLinks(plain, ctx));
  if (spellings(ctx.checkout).some((root) => isEqualOrUnder(real, join(root, '.git')))) {
    return { access: 'git-internal', realPath: real, viaLink };
  }
  if (isClaudeProtected(real, ctx)) return { access: 'claude-protected', realPath: real, viaLink };
  return { access: 'ok', realPath: real, viaLink };
}

/** The guard's file-access judge for one lane: protected reads and git internals are refused by real path. */
export function fileAccessJudge(ctx: FileAccessContext): FileAccessJudge {
  return {
    read(toolName, input) {
      for (const path of readPathsOf(toolName, input)) {
        if (readAccess(path, ctx).access === 'protected') {
          return { refuse: `${path} is a protected path; 10db never lets a lane read it.` };
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
