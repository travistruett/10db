import { LiveSystem, type LiveSystemProposalsDto } from '@10db/contracts';
import type { Git } from '../git';

/** One proposed entry and the line of the repo file it was read from. */
type ProductionProposal = LiveSystemProposalsDto['proposals'][number];

/** The most of one repository file read. */
const MAX_FILE_BYTES = 128 * 1024;
/** The most files read. */
const MAX_FILES = 80;
/** The most proposals returned. */
const MAX_PROPOSALS = 30;

const ENV_EXAMPLE = /(^|\/)\.env(\.[\w-]+)*\.example$|(^|\/)\.env\.example(\.[\w-]+)*$/;
const COMPOSE_PROD =
  /(^|\/)(docker-)?compose[\w.-]*\.(prod|production)[\w.-]*\.ya?ml$|(^|\/)(docker-)?compose\.(prod|production)\.ya?ml$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** Files whose text names the AWS and GCP profiles a command runs under. */
const PROFILE_FILES =
  /(^|\/)(Makefile|justfile|package\.json|samconfig\.toml|serverless\.ya?ml)$|^(scripts|bin|\.aws|infra|deploy)\/[^/]+$|\.(sh|tfvars)$/;

/** Hosts a repo's example files use as stand-ins, which name nothing real. */
const PLACEHOLDER_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$|(^|\.)(example(\.(com|org|net))?|local|localhost|test|invalid)$/;

const PROD_WORD = /(^|[^a-z])prod(uction)?([^a-z]|$)/i;

/** The host of a URL's text, or null when it is not one or only stands in for one. */
function hostOf(text: string): string | null {
  try {
    const { hostname } = new URL(text);
    return hostname === '' || PLACEHOLDER_HOST.test(hostname) || hostname.includes('$')
      ? null
      : hostname;
  } catch {
    return null;
  }
}

const URL_IN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`,)<>]+/gi;

interface Found {
  readonly entry: string;
  readonly line: number;
}

function hostsIn(text: string): string[] {
  return [...text.matchAll(URL_IN)].flatMap((m) => {
    const host = hostOf(m[0]);
    return host === null ? [] : [host];
  });
}

/** `vercel.json`: the domains the deployment is aliased to. */
function vercelEntries(text: string): Found[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof json !== 'object' || json === null) return [];
  const lines = text.split('\n');
  const found: Found[] = [];
  for (const key of ['alias', 'domains']) {
    const value = (json as Record<string, unknown>)[key];
    const names = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    for (const name of names) {
      if (typeof name !== 'string' || name.includes('*') || PLACEHOLDER_HOST.test(name)) continue;
      const at = lines.findIndex((l) => l.includes(`"${name}"`));
      found.push({ entry: name, line: at < 0 ? 1 : at + 1 });
    }
  }
  return found;
}

/** `.env.example`: the host a `*PROD*` name points at, and any URL whose host reads as production. */
function envEntries(text: string): Found[] {
  return text.split('\n').flatMap((raw, i): Found[] => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(raw);
    if (match === null) return [];
    const [, name = '', value = ''] = match;
    const named = /prod/i.test(name);
    return hostsIn(value)
      .filter((host) => named || PROD_WORD.test(host))
      .map((host) => ({ entry: host, line: i + 1 }));
  });
}

/** A prod compose file: the registry host of each service image. */
function composeEntries(text: string): Found[] {
  return text.split('\n').flatMap((raw, i): Found[] => {
    const image = /^\s*image:\s*['"]?([^'"\s#]+)/.exec(raw)?.[1];
    const first = image?.split('/')[0];
    const host = image?.includes('/') && first !== undefined && /[.:]/.test(first) ? first : null;
    return host === null || PLACEHOLDER_HOST.test(host) ? [] : [{ entry: host, line: i + 1 }];
  });
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * A workflow job named production or prod, or an `environment:` block named so: the literal `url` inside
 * it. A `url` built from an expression names nothing yet.
 */
function workflowEntries(text: string): Found[] {
  const lines = text.split('\n');
  const found: Found[] = [];
  lines.forEach((raw, i) => {
    // The block's own line, and where it starts.
    let block: { readonly at: number } | null = null;
    if (/^\s*(prod|production):\s*$/i.test(raw)) block = { at: i };
    else if (
      /^\s*name:\s*['"]?(prod|production)['"]?\s*(#.*)?$/i.test(raw) &&
      /^\s*environment:\s*$/.test(lines[i - 1] ?? '')
    )
      block = { at: i - 1 };
    if (block === null) return;
    const parent = indentOf(lines[block.at] ?? '');
    for (let j = block.at + 1; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (next.trim() === '') continue;
      if (indentOf(next) <= parent) break;
      const url = /^\s*url:\s*['"]?([^'"\s#]+)/.exec(next)?.[1];
      const host = url === undefined || url.includes('${{') ? null : hostOf(url);
      if (host !== null) found.push({ entry: host, line: j + 1 });
    }
  });
  return found;
}

/** AWS profiles and GCP projects whose names say production, as a script or config names them. */
function profileEntries(text: string): Found[] {
  const found: Found[] = [];
  const patterns: readonly [RegExp, (name: string) => string][] = [
    [/AWS_PROFILE\s*[=:]\s*['"]?([\w.-]*prod[\w.-]*)/gi, (n) => `AWS profile ${n}`],
    [/--profile[ =]['"]?([\w.-]*prod[\w.-]*)/gi, (n) => `AWS profile ${n}`],
    [/^\s*\[profile\s+([\w.-]*prod[\w.-]*)\]/gim, (n) => `AWS profile ${n}`],
    [
      /(?:--project[ =]|CLOUDSDK_CORE_PROJECT\s*[=:]\s*)['"]?([\w.-]*prod[\w.-]*)/gi,
      (n) => `GCP project ${n}`,
    ],
  ];
  text.split('\n').forEach((raw, i) => {
    for (const [pattern, entryOf] of patterns) {
      for (const m of raw.matchAll(pattern)) {
        const name = m[1];
        if (name !== undefined && !name.includes('$'))
          found.push({ entry: entryOf(name), line: i + 1 });
      }
    }
  });
  return found;
}

/** What one file proposes, by kind of file; pure. */
function proposalsFromFile(path: string, text: string): ProductionProposal[] {
  const found: Found[] = [];
  if (path === 'vercel.json' || path.endsWith('/vercel.json')) found.push(...vercelEntries(text));
  if (ENV_EXAMPLE.test(path)) found.push(...envEntries(text));
  if (COMPOSE_PROD.test(path)) found.push(...composeEntries(text));
  if (WORKFLOW.test(path)) found.push(...workflowEntries(text));
  if (
    PROFILE_FILES.test(path) ||
    ENV_EXAMPLE.test(path) ||
    WORKFLOW.test(path) ||
    COMPOSE_PROD.test(path)
  )
    found.push(...profileEntries(text));
  return found.flatMap(({ entry, line }) => {
    const parsed = LiveSystem.safeParse(entry);
    return parsed.success ? [{ entry: parsed.data, source: { path, line } }] : [];
  });
}

/**
 * Entries the repo suggests as production systems, each with the line it came from, minus those already
 * listed. Files are read from `origin/<base>`'s commit, else HEAD, in git's object store, so nothing the
 * repository holds runs and a lane's uncommitted write proposes nothing.
 */
export async function proposeProduction(
  git: Git,
  project: { readonly repoPath: string; readonly baseBranch: string },
  listed: readonly string[],
): Promise<ProductionProposal[]> {
  const tracking = await git
    .remoteTrackingCommit(project.repoPath, project.baseBranch)
    .catch(() => null);
  const rev = tracking ?? (await git.commitAt(project.repoPath, 'HEAD').catch(() => null));
  if (rev === null) return [];
  const files = await git.filesAt(project.repoPath, rev).catch(() => []);
  const wanted = files
    .filter(
      (f) =>
        f.split('/').length <= 4 &&
        (f === 'vercel.json' ||
          f.endsWith('/vercel.json') ||
          ENV_EXAMPLE.test(f) ||
          COMPOSE_PROD.test(f) ||
          WORKFLOW.test(f) ||
          PROFILE_FILES.test(f)),
    )
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, MAX_FILES);
  const known = new Set(listed.map((entry) => entry.toLowerCase()));
  const proposed = new Map<string, ProductionProposal>();
  for (const path of wanted) {
    const file = await git.fileAt(project.repoPath, rev, path, MAX_FILE_BYTES).catch(() => null);
    if (file?.kind !== 'file') continue;
    for (const proposal of proposalsFromFile(path, file.text)) {
      const key = proposal.entry.toLowerCase();
      if (!known.has(key) && !proposed.has(key)) proposed.set(key, proposal);
    }
  }
  return [...proposed.values()].slice(0, MAX_PROPOSALS);
}
