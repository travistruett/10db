import { z } from 'zod';
import type { Git } from '../git';
import type { Logger } from '../log';

/**
 * The repo's Conventional Commit scopes and the paths each covers. Data only: 10db never reads or runs a
 * repo's commitlint config, which is code.
 */
export const PR_SCOPES_PATH = '.10db/pr-scopes.json';

const MAX_PR_SCOPES_BYTES = 64 * 1024;

/** A scope as it sits between the parentheses of a title: nothing that could close them or end the type. */
const ScopeName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'a lowercase word such as daemon');

/** A file or directory relative to the repo root, written with `/` and no `.`, `..` or empty steps. */
const ScopePath = z
  .string()
  .max(256)
  .refine(
    (path) => path.split('/').every((step) => step !== '' && step !== '.' && step !== '..'),
    'a relative path with no ., .. or empty steps',
  );

const PrScopesFile = z.strictObject({
  scopes: z.record(ScopeName, z.array(ScopePath).min(1).max(64)),
});

/** Each scope and the files and directories it covers. */
export type PrScopes = Readonly<Record<string, readonly string[]>>;

/** The scope list in `text`, or null when it is not a valid `.10db/pr-scopes.json`. */
export function parsePrScopes(text: string): PrScopes | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = PrScopesFile.safeParse(json);
  return parsed.success ? parsed.data.scopes : null;
}

/**
 * The repo's scope list in commit `rev`, or null when it has none. It is read through git from the
 * commit, as the pull request template is, never from the checkout a lane writes. An invalid file is
 * no list: the title goes without a scope, and the log says why.
 */
export async function readPrScopes(
  git: Pick<Git, 'fileAt'>,
  repo: string,
  rev: string,
  logger: Logger,
): Promise<PrScopes | null> {
  const found = await git.fileAt(repo, rev, PR_SCOPES_PATH, MAX_PR_SCOPES_BYTES);
  switch (found.kind) {
    case 'file': {
      const scopes = parsePrScopes(found.text);
      if (scopes === null) logger.warn({ path: PR_SCOPES_PATH, rev }, 'pr scopes not valid');
      return scopes;
    }
    case 'missing':
      return null;
    case 'not_regular':
      logger.warn({ path: PR_SCOPES_PATH, mode: found.mode, rev }, 'pr scopes not a file');
      return null;
    case 'too_large':
      logger.warn(
        { path: PR_SCOPES_PATH, bytes: found.bytes, maxBytes: MAX_PR_SCOPES_BYTES, rev },
        'pr scopes too large',
      );
      return null;
  }
}

/** The scope of the entry that covers `path` most closely, or null when none covers it. */
function scopeOfPath(path: string, scopes: PrScopes): string | null {
  let best: { scope: string; length: number } | null = null;
  for (const [scope, entries] of Object.entries(scopes))
    for (const entry of entries)
      if ((path === entry || path.startsWith(`${entry}/`)) && entry.length > (best?.length ?? -1))
        best = { scope, length: entry.length };
  return best?.scope ?? null;
}

/**
 * The one scope that covers every changed path, or null when the paths span several scopes, any path
 * lies outside them all, nothing changed or the repo lists no scopes.
 */
export function scopeOf(paths: readonly string[], scopes: PrScopes | null): string | null {
  if (scopes === null) return null;
  const found = new Set<string | null>(paths.map((path) => scopeOfPath(path, scopes)));
  const [only] = found;
  return found.size === 1 && only !== undefined ? only : null;
}
