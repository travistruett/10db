import type { ClaimKind, ProjectDto, ProjectId } from '@10db/contracts';
import { classifyPath } from '../guard';

/** More strays than this in one batch become a single card. */
export const STRAY_BULK_THRESHOLD = 50;

/** Path segments that are never the agent's work, at any depth. */
const IGNORED_SEGMENTS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.DS_Store']);

export function isAlwaysIgnored(rel: string): boolean {
  return rel.split('/').some((segment) => IGNORED_SEGMENTS.has(segment));
}

export function strayFoldKey(projectId: ProjectId, rel: string): string {
  return `stray-write:${projectId}:${rel}`;
}

export function bulkFoldKey(projectId: ProjectId): string {
  return `stray-write:${projectId}:bulk`;
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
