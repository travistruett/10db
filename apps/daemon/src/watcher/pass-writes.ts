import type {
  ClaimKind,
  PassDirtEntry,
  PassSharedChangeDto,
  ProjectDto,
  WorkstreamId,
} from '@10db/contracts';
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

/** What the pass accounts for at a path of Your folder. */
export interface Accounted {
  /** The commit whose entry gives the path's mode (`Git.blobsAt`). */
  readonly at: string;
  /** The content the database recorded for the path; null for a file that is not there. */
  readonly blob: string | null;
}

/**
 * What the pass accounts for at each path of Your folder, by path: the newest change on the pass's
 * shared chain that sets it (spec §7.2: its turn's end kept it and let the area go, and it stays in the
 * folder until it lands; a drop is the newest when it put the path back), else what the pass's open
 * recorded of the folder's dirt (spec §5.1). The content is the database's; only the mode is read from
 * the commit, so a ref moved since accounts for nothing new. A path still holding both is no write made
 * in the pass, whatever claim covers it.
 */
export function accountedAt(input: {
  /** The pass's dirt commit, whose tree holds the folder's dirt as the open found it. */
  readonly dirtRef: string;
  readonly dirt: readonly PassDirtEntry[];
  /** The pass's shared chain, drops included. */
  readonly shared: readonly Pick<PassSharedChangeDto, 'seq' | 'sha' | 'paths' | 'blobs'>[];
}): Map<string, Accounted> {
  const at = new Map<string, Accounted>(
    input.dirt.map((entry) => [entry.path, { at: input.dirtRef, blob: entry.blob }]),
  );
  for (const change of [...input.shared].sort((a, b) => a.seq - b.seq))
    for (const path of change.paths)
      at.set(path, { at: change.sha, blob: change.blobs[path] ?? null });
  return at;
}
