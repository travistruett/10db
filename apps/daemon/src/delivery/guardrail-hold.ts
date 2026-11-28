import { createHash } from 'node:crypto';
import type { BatchDto, BatchId } from '@10db/contracts';
import { getAppSetting, type DbReader } from '@10db/db';
import { z } from 'zod';
import type { Git } from '../git';
import { guardrailHits } from '../guardrails';

/**
 * A pull request that changes a guardrail path is never armed or merged by 10db until the builder answers
 * Merge for that exact diff. The decision is the path list's alone: no judge answer, watchpoint answer or
 * card state is read here. The hold belongs to the pull request, so it is keyed by the root batch that
 * opened it, whichever batch ships into it.
 */

/** The root batch of the pull request `batch` ships into: a CI fix's own root, else the batch itself. */
export function holdRootOf(batch: Pick<BatchDto, 'id' | 'ciFixOf'>): BatchId {
  return batch.ciFixOf ?? batch.id;
}

/** The app setting holding what the builder approved for the root batch's pull request. */
export const guardrailHoldKey = (rootId: BatchId): string => `guardrail_hold.${rootId}`;

/** The setting's value: the hash of the guardrail diff the builder merged. */
export const GuardrailHold = z.object({ approved: z.string().nullable() });
export type GuardrailHold = z.infer<typeof GuardrailHold>;

/** The hash the builder approved for the root's pull request; null when none, or when the row can't be read. */
export function approvedHashOf(db: DbReader, rootId: BatchId): string | null {
  // Read from the database: parsed, as at every boundary.
  const stored = GuardrailHold.safeParse(getAppSetting(db, guardrailHoldKey(rootId)));
  return stored.success ? stored.data.approved : null;
}

/**
 * Where the pull request's whole change starts, so a CI fix's own range or a catch-up's merged base never
 * hides or adds a path: the merge base of `head` and the base branch as origin has it, else the batch's
 * cut point, else null.
 */
export async function pullRequestBase(
  git: Git,
  checkout: string,
  root: BatchDto,
  head: string,
): Promise<string | null> {
  try {
    const base = await git.mergeBase(checkout, head, `refs/remotes/origin/${root.baseBranch}`);
    if (base !== null) return base;
  } catch {
    // No such tracking ref: the cut point stands in.
  }
  return root.baseSha;
}

export type HoldAction = 'none' | 'hold' | 'approved';

/** First match wins; `hits` and `diffHash` are over the whole pull request. */
export function holdAction(input: {
  /** How many guardrail paths the pull request changes; null when its diff could not be read. */
  readonly hits: number | null;
  readonly diffHash: string | null;
  /** The hash the builder merged. */
  readonly approved: string | null;
}): HoldAction {
  if (input.hits === 0) return 'none';
  if (input.hits === null || input.diffHash === null) return 'hold';
  if (input.approved !== null && input.approved === input.diffHash) return 'approved';
  return 'hold';
}

/** The most bytes of the guardrail paths' diff read; the hash also covers the per-file counts of all of it. */
const MAX_HOLD_DIFF_BYTES = 2 * 1024 * 1024;

/** What one read of a pull request's guardrail diff found. */
export interface GuardrailReading {
  readonly action: HoldAction;
  /** The guardrail paths the pull request changes; null when the diff could not be read. */
  readonly hits: readonly { readonly path: string; readonly label: string }[] | null;
  /** The hash of the hit paths' diff; null with no hits or an unreadable diff. */
  readonly diffHash: string | null;
  /** The hit paths' diff text, cut at the read's cap. */
  readonly diff: string | null;
}

const UNREADABLE: Omit<GuardrailReading, 'action'> = { hits: null, diffHash: null, diff: null };

/**
 * Reads the guardrail diff of the root's pull request at `head`, over its whole change from `pullRequestBase`.
 * Paths come without rename detection, so a guardrail file moved out of its folder lists as a deletion at the
 * guardrail path. The hash is over the hit paths only, so an unrelated later commit changes nothing. A null
 * head, no base, or any failed read is an unreadable diff, which holds.
 */
export async function readGuardrailHold(
  deps: { readonly git: Git; readonly db: DbReader },
  input: { readonly checkout: string; readonly root: BatchDto; readonly head: string | null },
): Promise<GuardrailReading> {
  const approved = approvedHashOf(deps.db, input.root.id);
  const unreadable = (): GuardrailReading => ({
    action: holdAction({ hits: null, diffHash: null, approved }),
    ...UNREADABLE,
  });
  if (input.head === null) return unreadable();
  try {
    const base = await pullRequestBase(deps.git, input.checkout, input.root, input.head);
    if (base === null) return unreadable();
    const paths = await deps.git.filesChangedBetween(input.checkout, base, input.head);
    const hits = guardrailHits(paths);
    if (hits.length === 0)
      return {
        action: holdAction({ hits: 0, diffHash: null, approved }),
        hits: [],
        diffHash: null,
        diff: null,
      };
    const hitPaths = new Set(hits.map((hit) => hit.path));
    const read = await deps.git.diffSince(input.checkout, base, input.head, MAX_HOLD_DIFF_BYTES, {
      only: [...hitPaths],
    });
    // The counts cover the whole change, so only the hit paths' own are hashed.
    const files = read.files.filter((file) => hitPaths.has(file.path));
    const diffHash = createHash('sha256')
      .update(JSON.stringify({ files, truncated: read.truncated, diff: read.diff }))
      .digest('hex');
    return {
      action: holdAction({ hits: hits.length, diffHash, approved }),
      hits: hits.map(({ path, label }) => ({ path, label })),
      diffHash,
      diff: read.diff,
    };
  } catch {
    return unreadable();
  }
}
