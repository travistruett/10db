import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BatchDto, WorkstreamDto } from '@10db/contracts';
import { getBatch, listWorkstreams, patchWorkstream } from '@10db/db';
import type { DeliveryHarness } from './delivery-harness';

/**
 * The named states a delivery test starts from, each built through the real pipeline on a
 * `createDeliveryHarness`. Each world is the one before it plus one step, and each checks it got
 * there, so a test that starts from one never starts from a state the daemon can't reach:
 *
 * | World       | What holds                                                                     |
 * | ----------- | ------------------------------------------------------------------------------ |
 * | `opened`    | one task started; its batch OPEN with its one workstream                       |
 * | `committed` | `opened`, plus one commit on the batch's branch, as the commit tool makes it    |
 * | `shipped`   | `committed`, shipped: SHIPPED, a PR open, the branch local and on origin, where |
 * |             | its tip holds the commit                                                       |
 *
 * A test that needs a state none of these give adds a world here rather than building one in its
 * own file.
 */

/** A world asked for a part its batch doesn't have, or the pipeline didn't reach the world. */
export class WorldError extends Error {
  override readonly name = 'WorldError';
}

export interface Opened {
  readonly batch: BatchDto;
  readonly ws: WorkstreamDto;
}

export interface Committed extends Opened {
  /** The commit on the batch's branch. */
  readonly head: string;
}

export interface Shipped extends Opened {
  /** The commit `committed` made. */
  readonly commit: string;
  /**
   * The commit the pull request is at, on origin and on GitHub: `commit`, or a merge on top of it
   * when the ship brought the base in first.
   */
  readonly head: string;
  readonly prUrl: string;
}

interface Titled {
  /** The task's title; also names the file `committed` writes. */
  readonly title?: string;
}

interface FileOptions {
  /** The file the commit writes, relative to the checkout; `src/api/<title>.txt` by default. */
  readonly path?: string;
  readonly content?: string;
}

/** A world built from the one given, which already has its title. */
interface From<World> {
  readonly from: World;
  readonly title?: never;
}

/** A world built from scratch. */
interface Fresh extends Titled {
  readonly from?: never;
}

/** The batch's worktree; throws for a batch that runs in the project's own checkout. */
export function pathOf(batch: BatchDto): string {
  if (batch.worktreePath === null)
    throw new WorldError(`batch ${batch.title} has no worktree path`);
  return batch.worktreePath;
}

/** Where the batch's work is checked out: its worktree, or the project's checkout when shared. */
export function checkoutOf(h: DeliveryHarness, batch: BatchDto): string {
  return batch.worktreePath ?? h.repo;
}

export function branchOf(batch: BatchDto): string {
  if (batch.branch === null) throw new WorldError(`batch ${batch.title} has no branch`);
  return batch.branch;
}

/** The SHA of `branch` on origin, or null when origin doesn't have it. */
export function onOrigin(h: DeliveryHarness, branch: string | null): string | null {
  try {
    return h.origin$('rev-parse', '--verify', '-q', `refs/heads/${branch ?? ''}`);
  } catch {
    return null;
  }
}

/**
 * Commits `path` on the batch's branch as the commit tool does for an agent, and returns the SHA.
 * The operation id names the path and the content, so committing new content to the same path
 * makes a new commit.
 */
export async function commitIn(
  h: DeliveryHarness,
  batch: BatchDto,
  path: string,
  content = `${path}\n`,
): Promise<string> {
  const checkout = checkoutOf(h, batch);
  const file = join(checkout, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 12);
  const { sha } = await h.git.commit({
    repo: checkout,
    paths: [path],
    message: `Add ${path}`,
    opId: `op-${path.replaceAll('/', '-')}-${digest}`,
    branch: branchOf(batch),
  });
  return sha;
}

/** One task started and its batch OPEN. */
export async function opened(
  h: DeliveryHarness,
  opts: Titled & {
    /** The runner's first session has begun and recorded the workstream's base head. */
    readonly sessionStarted?: boolean;
  } = {},
): Promise<Opened> {
  const started = h.starter.startTask(h.addTask(opts.title ?? 'Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  if (batch.state !== 'OPEN')
    throw new WorldError(`batch ${batch.title} is ${batch.state} after its start, not OPEN`);
  const ws = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
  if (opts.sessionStarted) {
    const baseHead = batch.baseSha;
    if (baseHead === null) throw new WorldError(`batch ${batch.title} has no base commit`);
    h.state.write((c) => {
      patchWorkstream(c, ws.id, null, { baseHead });
    });
  }
  return { batch, ws };
}

/** `opened`, or the world given as `from`, plus one commit on the batch's branch. */
export async function committed(
  h: DeliveryHarness,
  opts: FileOptions & (From<Opened> | Fresh) = {},
): Promise<Committed> {
  const world = opts.from ?? (await opened(h, opts));
  const path = opts.path ?? `src/api/${world.batch.title.toLowerCase()}.txt`;
  const head = await commitIn(h, world.batch, path, opts.content);
  return { ...world, head };
}

/**
 * `committed`, or the world given as `from`, with its workstream done and the batch shipped, and
 * GitHub reporting the pull request at `head`.
 */
export async function shipped(
  h: DeliveryHarness,
  opts:
    | (FileOptions & Fresh)
    | (From<Committed> & { readonly path?: never; readonly content?: never }) = {},
): Promise<Shipped> {
  const world = opts.from ?? (await committed(h, opts));
  h.settle(world.ws.id, 'DONE');
  h.shipper.checkBatch(world.batch.id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, world.batch.id);
  if (batch.state !== 'SHIPPED' || batch.prUrl === null)
    throw new WorldError(
      `batch ${batch.title} is ${batch.state} after its ship, not SHIPPED with a pull request`,
    );
  const branch = branchOf(batch);
  if (h.git$('branch', '--list', branch) === '')
    throw new WorldError(`the ship left no local branch ${branch}`);
  const head = onOrigin(h, branch);
  if (head === null) throw new WorldError(`origin has no branch ${branch}`);
  if (!holds(h, head, world.head))
    throw new WorldError(`origin's ${branch} is at ${head}, which lacks the commit ${world.head}`);
  h.gh.setHead(batch.prUrl, head);
  return { batch, ws: world.ws, commit: world.head, head, prUrl: batch.prUrl };
}

/** Whether `tip` on origin is `commit` or descends from it. */
function holds(h: DeliveryHarness, tip: string, commit: string): boolean {
  try {
    h.origin$('merge-base', '--is-ancestor', commit, tip);
    return true;
  } catch {
    return false;
  }
}
