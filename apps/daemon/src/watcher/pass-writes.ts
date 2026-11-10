import type { ClaimKind, PassDirtEntry, ProjectDto, WorkstreamId } from '@10db/contracts';
import { findClaimed } from './strays';

// Workbench spec §6.4: while a pass holds its tasks, a write in Your folder inside a page is the
// builder's hand edit or its own agent's work, and the fold finds it; one outside every claim is the
// builder's unless an agent of the pass was working, whose shell the guard's hook does not see.

/** A lane of a pass, as a write in Your folder is judged against it. */
export interface PassLane {
  readonly id: WorkstreamId;
  readonly title: string;
  /** `RUNNING` or `HANDING_OFF`: its agent may be writing now. */
  readonly working: boolean;
  readonly claims: readonly { readonly kind: ClaimKind; readonly name: string }[];
}

/** What the watcher raises for writes in Your folder while a pass holds its tasks. */
export interface PassWrites {
  /** Writes outside every claim that get the stray card: all of them while a lane works, else none. */
  readonly strays: readonly string[];
  /** The writes left for the foreign-claim check: none inside a claim a task of the pass holds. */
  readonly foreign: readonly string[];
  /** The lanes working now, which a stray card names. */
  readonly working: readonly PassLane[];
}

/**
 * Sorts writes in Your folder while a pass (open, closing or abandoning: a close's or an Abandon's
 * take-outs write page files) holds its tasks. A write inside a claim a task of the pass holds raises
 * neither card: it is a page's, and the fold of hand edits finds it. A write outside every claim
 * raises the stray card only while a lane of the pass is working, naming the lanes.
 */
export function passWrites(input: {
  readonly project: Pick<ProjectDto, 'areas' | 'hazards'>;
  readonly lanes: readonly PassLane[];
  /** Writes outside every claim. */
  readonly strays: readonly string[];
  /** Writes the foreign-claim check would read. */
  readonly foreign: readonly string[];
}): PassWrites {
  const held = input.lanes.flatMap((lane) => lane.claims);
  const inPass = new Set(findClaimed([...input.strays, ...input.foreign], input.project, held));
  const working = input.lanes.filter((lane) => lane.working);
  return {
    strays: working.length === 0 ? [] : input.strays.filter((path) => !inPass.has(path)),
    foreign: input.foreign.filter((path) => !inPass.has(path)),
    working,
  };
}

/**
 * What each path of Your folder holds while the pass accounts for it, by path (null: not there): what
 * the pass's open recorded of the folder's dirt (spec §5.1). A path that still holds it is no write
 * made in the pass, whatever claim covers it.
 */
export function accountedContent(input: {
  readonly dirt: readonly PassDirtEntry[];
}): Map<string, string | null> {
  return new Map(input.dirt.map((entry) => [entry.path, entry.blob]));
}
