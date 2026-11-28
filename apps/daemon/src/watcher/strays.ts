import { ClaimKind, WHOLE_PROJECT_PAGE, type ProjectDto, type WorkstreamId } from '@10db/contracts';
import { classifyPath } from '../guard';
import { guardrailOf } from '../guardrails';
import { isInsideClaudeCodeBookkeeping } from '../git';

/** More strays than this in one batch become a single card. */
export const STRAY_BULK_THRESHOLD = 50;

/**
 * Paths a session can use to change what runs or what is visible, so a write to one is flagged even when
 * git ignores it or never reports it: agent and tool config, secrets, and the parts of `.git` that hold
 * hooks, excludes and config (an exclude hides later writes; config can name programs git runs).
 */
const SENSITIVE_DIRECTORIES = ['.claude', '.codex', '.git/hooks', '.git/info'] as const;
const SENSITIVE_FILES = ['.mcp.json', '.git/config'] as const;
const SENSITIVE_BASENAME = /^\.env(\..+)?$/;

/**
 * A sensitive directory itself counts: moving one into place arrives as a single event for its own path.
 * A path inside Claude Code's own bookkeeping doesn't (`claude-code-bookkeeping.ts`); it is judged like any
 * other path, so it is dropped while git ignores it and checked against the claims when git reports it. The
 * bookkeeping directory's own path stays sensitive here, since text can't tell a link or a file there from the
 * directory; the watcher exempts it after looking.
 */
export function isSensitivePath(rel: string): boolean {
  if (isInsideClaudeCodeBookkeeping(rel)) return false;
  if (SENSITIVE_DIRECTORIES.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) return true;
  if (SENSITIVE_FILES.some((file) => file === rel)) return true;
  if (rel === '.git/config.worktree' || WORKTREE_CONFIG.test(rel)) return true;
  return SENSITIVE_BASENAME.test(rel.slice(rel.lastIndexOf('/') + 1));
}

const GUARDRAIL_BASENAME = /^(AGENTS\.md|CLAUDE\.md|lefthook\.ya?ml|\.lefthook\.ya?ml)$/;

/**
 * Paths the builder alone owns, whose change is the builder's to keep or revert (the git guard, hooks, agent
 * instructions and rules, CI workflows, secrets): the guardrail list (`guardrails/paths.ts`), the sensitive
 * paths above, plus the agent instructions and lefthook's config of any folder. A write outside every claim to
 * one of these is a card; to any other path it is a notice in Activity.
 */
export function isGuardrailPath(rel: string): boolean {
  if (guardrailOf(rel) !== null) return true;
  if (isSensitivePath(rel)) return true;
  return GUARDRAIL_BASENAME.test(rel.slice(rel.lastIndexOf('/') + 1));
}

/** The file lefthook keeps in `.git/info` to decide whether to reinstall its hooks. */
export const LEFTHOOK_CHECKSUM_PATH = '.git/info/lefthook.checksum';
/** What lefthook writes there: a hash and a timestamp, nothing that runs or hides anything. */
const LEFTHOOK_CHECKSUM_CONTENT = /^[0-9a-f]{32} \d+\s*$/;

/** Whether a write to `rel` holding `content` is lefthook's checksum bookkeeping, which raises no card. */
export function isLefthookChecksum(rel: string, content: string): boolean {
  return rel === LEFTHOOK_CHECKSUM_PATH && LEFTHOOK_CHECKSUM_CONTENT.test(content);
}

/**
 * What git itself writes for `worktree add`, `push -u` and `branch --set-upstream-to`, as `git config --list`
 * prints keys (section and key lowercase): a branch's `merge`, its `remote` when the value names a remote the
 * config already defines (a URL or path there is a program-reachable target, so it is carded), and
 * `worktree.guessremote`. Every other key, `extensions.worktreeconfig` and the rest of `branch.<name>.*`
 * included, is a change.
 */
function isGitBookkeepingKey(name: string, after: ReadonlyMap<string, readonly string[]>): boolean {
  if (name === 'worktree.guessremote') return true;
  if (/^branch\..+\.merge$/.test(name)) return true;
  if (!/^branch\..+\.remote$/.test(name)) return false;
  return (after.get(name) ?? []).every((remote) => after.has(`remote.${remote}.url`));
}

/** The keys whose values differ between two parsed configs, git's own bookkeeping keys left out. */
export function changedConfigKeys(
  before: ReadonlyMap<string, readonly string[]>,
  after: ReadonlyMap<string, readonly string[]>,
): string[] {
  const same = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
    a?.length === b?.length && (a ?? []).every((value, i) => value === b?.[i]);
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (name) => !same(before.get(name), after.get(name)) && !isGitBookkeepingKey(name, after),
  );
}

/** A config file whose keys are diffed rather than carded whole: the repository's, or a worktree's own. */
export function isConfigFile(rel: string): boolean {
  return rel === '.git/config' || rel === '.git/config.worktree' || WORKTREE_CONFIG.test(rel);
}
const WORKTREE_CONFIG = /^\.git\/worktrees\/[^/]+\/config\.worktree$/;

/** Splits items so sensitive paths can get their own cards and never fold into a bulk card. */
export function splitSensitive<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
): { sensitive: T[]; ordinary: T[] } {
  const sensitive: T[] = [];
  const ordinary: T[] = [];
  for (const item of items) (isSensitivePath(pathOf(item)) ? sensitive : ordinary).push(item);
  return { sensitive, ordinary };
}

/** Churn that is never the agent's work: git's own bookkeeping at the repo root, and Finder droppings. */
export function isAlwaysIgnored(rel: string): boolean {
  if (rel.slice(rel.lastIndexOf('/') + 1) === '.DS_Store') return true;
  const inGitDir = rel === '.git' || rel.startsWith('.git/');
  return inGitDir && !isSensitivePath(rel);
}

/** `scope` is the project's id in a shared checkout and the batch's id in a worktree. */
export function strayFoldKey(scope: string, rel: string): string {
  return `stray-write:${scope}:${rel}`;
}

export function bulkFoldKey(scope: string): string {
  return `stray-write:${scope}:bulk`;
}

export function foreignBulkFoldKey(scope: string): string {
  return `stray-write:${scope}:bulk-foreign`;
}

/** Whether a held claim covers the path: one of its areas or hazards is held. */
function isClaimed(
  rel: string,
  project: Pick<ProjectDto, 'areas' | 'hazards'>,
  held: ReadonlySet<string>,
): boolean {
  const hit = classifyPath(rel, project.areas, project.hazards);
  // The whole-project page covers every file but a hazard's, which is covered only by its hazard claim.
  if (hit.areas.includes(WHOLE_PROJECT_PAGE.name) && hit.hazards.length > 0)
    return hit.hazards.every((h) => held.has(`hazard:${h}`));
  return (
    hit.areas.some((a) => held.has(`area:${a}`)) || hit.hazards.some((h) => held.has(`hazard:${h}`))
  );
}

function heldClaims(claims: readonly { readonly kind: ClaimKind; readonly name: string }[]) {
  return new Set(claims.map((c) => `${c.kind}:${c.name}`));
}

/** Paths that no held claim covers: their areas and hazards are all unclaimed. */
export function findStrays(
  paths: readonly string[],
  project: Pick<ProjectDto, 'areas' | 'hazards'>,
  claims: readonly { readonly kind: ClaimKind; readonly name: string }[],
): string[] {
  const held = heldClaims(claims);
  return paths.filter((rel) => !isClaimed(rel, project, held));
}

/** Paths a held claim covers: the complement of `findStrays` over the same claims. */
export function findClaimed(
  paths: readonly string[],
  project: Pick<ProjectDto, 'areas' | 'hazards'>,
  claims: readonly { readonly kind: ClaimKind; readonly name: string }[],
): string[] {
  const held = heldClaims(claims);
  return paths.filter((rel) => isClaimed(rel, project, held));
}

export interface ClaimHolder {
  readonly id: WorkstreamId;
  readonly running: boolean;
  readonly claims: readonly { readonly kind: ClaimKind; readonly name: string }[];
}

/**
 * Paths inside a claim, none of whose holders is running: a session wrote into a claim that isn't its own.
 * A path inside a running workstream's claim is that workstream's work.
 */
export function findForeignClaimWrites(
  paths: readonly string[],
  project: Pick<ProjectDto, 'areas' | 'hazards'>,
  holders: readonly ClaimHolder[],
): { path: string; holders: WorkstreamId[] }[] {
  const found: { path: string; holders: WorkstreamId[] }[] = [];
  for (const path of paths) {
    const hit = classifyPath(path, project.areas, project.hazards);
    const covering = holders.filter((holder) =>
      holder.claims.some((c) =>
        (c.kind === ClaimKind.Area ? hit.areas : hit.hazards).includes(c.name),
      ),
    );
    if (covering.length > 0 && !covering.some((holder) => holder.running)) {
      found.push({ path, holders: covering.map((holder) => holder.id) });
    }
  }
  return found;
}
