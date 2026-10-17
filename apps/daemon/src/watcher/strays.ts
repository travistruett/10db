import { ClaimKind, type ProjectDto, type ProjectId, type WorkstreamId } from '@10db/contracts';
import { classifyPath } from '../guard';

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

/** A sensitive directory itself counts: moving one into place arrives as a single event for its own path. */
export function isSensitivePath(rel: string): boolean {
  if (SENSITIVE_DIRECTORIES.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) return true;
  if (SENSITIVE_FILES.some((file) => file === rel)) return true;
  return SENSITIVE_BASENAME.test(rel.slice(rel.lastIndexOf('/') + 1));
}

/** Churn that is never the agent's work: git's own bookkeeping at the repo root, and Finder droppings. */
export function isAlwaysIgnored(rel: string): boolean {
  if (rel.slice(rel.lastIndexOf('/') + 1) === '.DS_Store') return true;
  const inGitDir = rel === '.git' || rel.startsWith('.git/');
  return inGitDir && !isSensitivePath(rel);
}

export function strayFoldKey(projectId: ProjectId, rel: string): string {
  return `stray-write:${projectId}:${rel}`;
}

export function bulkFoldKey(projectId: ProjectId): string {
  return `stray-write:${projectId}:bulk`;
}

export function foreignBulkFoldKey(projectId: ProjectId): string {
  return `stray-write:${projectId}:bulk-foreign`;
}

/** Paths that no held claim covers: their areas and hazards are all unclaimed. */
export function findStrays(
  paths: readonly string[],
  project: Pick<ProjectDto, 'areas' | 'hazards'>,
  claims: readonly { readonly kind: ClaimKind; readonly name: string }[],
): string[] {
  const held = new Set(claims.map((c) => `${c.kind}:${c.name}`));
  return paths.filter((rel) => {
    const hit = classifyPath(rel, project.areas, project.hazards);
    return (
      !hit.areas.some((a) => held.has(`area:${a}`)) &&
      !hit.hazards.some((h) => held.has(`hazard:${h}`))
    );
  });
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
