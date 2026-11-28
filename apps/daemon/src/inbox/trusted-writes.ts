import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  BuilderOwns,
  GUARDRAIL_DIFF_DETAIL,
  InboxKind,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type ProjectId,
} from '@10db/contracts';
import {
  getAppSetting,
  setAppSetting,
  type DbReader,
  type Json,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';
import { existsAsEntry } from '../git';
import { BY_ANSWER, CardTier, decidedByBuilder } from './card-tier';
import { GuardrailStrayChoice } from './guardrail-card';
import type { FlagInput } from './service';

/** The answers a single stray-write card offers, shown as written. Dismiss closes only that card. */
export const TrustChoice = {
  Trust: 'Trust This Version',
  Keep: 'Keep It',
  Dismiss: 'Dismiss',
} as const;
export type TrustChoice = (typeof TrustChoice)[keyof typeof TrustChoice];

/** The card's detail keys: the sha256 the watcher stamped and the checkout the path is in. */
const SHA_DETAIL = 'sha256';
const ROOT_DETAIL = 'root';
const PATH_DETAIL = 'path';
const FOLD_DETAIL = 'foldKey';
const SENSITIVE_DETAIL = 'sensitive';

/** A file bigger than this is not stamped, so its card offers no trust and no answer reads it whole. */
const MAX_STAMPED_BYTES = 32 * 1024 * 1024;
/** The most trusted writes kept per project; the oldest go first. */
const MAX_TRUSTED = 500;

const TrustedWrite = z.object({ path: z.string(), sha256: z.string(), trustedAt: z.string() });
export type TrustedWrite = z.infer<typeof TrustedWrite>;
const TrustedWrites = z.array(TrustedWrite);

const settingKey = (projectId: ProjectId): string => `trusted_writes.${projectId}`;

/** What `readSmallFile` found at a path. */
export type SmallRead =
  | { readonly kind: 'file'; readonly bytes: Buffer }
  | { readonly kind: 'missing' }
  /** Something is there that is not a regular file within the size limit: a link, a FIFO, a directory, a huge file. */
  | { readonly kind: 'unreadable' };

/**
 * A regular file's bytes. The open is non-blocking and refuses a link at the path (O_NOFOLLOW), and the
 * kind and size come from the open descriptor, so a FIFO or a link swapped in after a look never blocks
 * the daemon and is never followed. The synchronous twin of the stamp read in `watcher/allowed-writes.ts`,
 * for callers inside a transaction.
 */
export function readSmallFile(path: string, maxBytes: number): SmallRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return { kind: 'unreadable' };
    const bytes = Buffer.allocUnsafe(info.size);
    let filled = 0;
    while (filled < bytes.length) {
      const read = readSync(fd, bytes, filled, bytes.length - filled, null);
      if (read === 0) break;
      filled += read;
    }
    return { kind: 'file', bytes: bytes.subarray(0, filled) };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    closeSync(fd);
  }
}

/** The sha256 of some bytes, as a card's stamp. */
export const shaOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The sha256 of a regular file in a checkout; null for a missing file, a link, a directory or a huge file. */
export function stampFile(root: string, rel: string): string | null {
  const read = readSmallFile(join(root, rel), MAX_STAMPED_BYTES);
  return read.kind === 'file' ? shaOf(read.bytes) : null;
}

/** The first 12 hex digits of a stamp, as a card shows it. */
export const shortSha = (sha: string): string => sha.slice(0, 12);

/** What a stray-write card carries so its answer can trust the version it showed. */
export function stampDetail(root: string, sha256: string, foldKey: string): Record<string, Json> {
  return { [ROOT_DETAIL]: root, [SHA_DETAIL]: sha256, [FOLD_DETAIL]: foldKey };
}

/** What a stray-write card for a sensitive path carries, so a lane's end or retry leaves it open. */
export const sensitiveDetail = { [SENSITIVE_DETAIL]: true } as const;

/** Whether the card is a stray write to a sensitive path: the builder's to decide, whatever becomes of the lane. */
export function isSensitiveStray(item: InboxItemDto): boolean {
  return item.kind === InboxKind.Flag && item.detail?.[SENSITIVE_DETAIL] === true;
}

/** What a stamped stray-write card names: the file, its checkout, the card's fold key and the stamp it showed. */
export interface StampedStray {
  readonly path: string;
  readonly root: string;
  readonly foldKey: string;
  readonly stamped: string;
}

/** The file a stamped stray-write card is about, or null for any other card. */
export function stampedStray(item: InboxItemDto): StampedStray | null {
  const path = item.detail?.[PATH_DETAIL];
  const root = item.detail?.[ROOT_DETAIL];
  const foldKey = item.detail?.[FOLD_DETAIL];
  const stamped = stampOf(item.detail);
  if (
    typeof path !== 'string' ||
    typeof root !== 'string' ||
    typeof foldKey !== 'string' ||
    stamped === null
  )
    return null;
  return { path, root, foldKey, stamped };
}

/** The sha256 a card was raised with, or null when it carries none. */
export function stampOf(detail: InboxItemDto['detail']): string | null {
  const sha = detail?.[SHA_DETAIL];
  return typeof sha === 'string' ? sha : null;
}

/** The two options of a single stray-write card; `trust` is Trust This Version, or Keep It on a foreign write. */
export function trustOptions(
  trust: typeof TrustChoice.Trust | typeof TrustChoice.Keep,
): InboxOption[] {
  return [
    {
      label: trust,
      description:
        'Stop flagging this exact content at this path. A different write there is flagged again.',
    },
    { label: TrustChoice.Dismiss, description: 'Close this card only' },
  ];
}

/** The writes the builder trusted for a project. */
export function trustedWrites(db: DbReader, projectId: ProjectId): TrustedWrite[] {
  const parsed = TrustedWrites.safeParse(getAppSetting(db, settingKey(projectId)));
  return parsed.success ? parsed.data : [];
}

/** Whether a trusted write holds this path with exactly this content. */
export function isTrusted(trusted: readonly TrustedWrite[], rel: string, sha256: string): boolean {
  return trusted.some((t) => t.path === rel && t.sha256 === sha256);
}

/**
 * The card to raise afresh when its file changed after the card was raised and the answer therefore acted on
 * nothing: stamped with the version the file holds now (`now`), or, for one that can no longer be stamped, with
 * no choice but Dismiss. A diff the old card showed is not carried over, since it is no longer the file's.
 */
export function changedSinceCard(
  item: InboxItemDto,
  root: string,
  foldKey: string,
  now: string | null,
): FlagInput {
  const named = item.detail?.[PATH_DETAIL];
  const path = typeof named === 'string' ? named : '';
  const rest = Object.fromEntries(
    Object.entries(item.detail ?? {}).filter(
      ([key]) => key !== SHA_DETAIL && key !== GUARDRAIL_DIFF_DETAIL,
    ),
  );
  // The old body named what the old version changed, so it is not reused: the first line is the path.
  const body = `${item.body.split('\n')[0] ?? path}\nChanged after this card was raised`;
  return {
    projectId: item.projectId,
    tier: CardTier.Ask,
    urgency: item.urgency,
    closesWhen: BY_ANSWER,
    decision: decidedByBuilder(BuilderOwns.Guardrails),
    workstreamId: item.targets[0]?.workstreamId ?? null,
    title: item.title,
    body: now === null ? body : `${body}\nVersion ${shortSha(now)}`,
    detail: now === null ? rest : { ...rest, ...stampDetail(root, now, foldKey) },
    options:
      now === null
        ? [{ label: TrustChoice.Dismiss, description: 'Close this card only' }]
        : item.options,
    foldKey,
  };
}

/**
 * Trust This Version, or Keep It, on a single stray-write card stamps the file again in the answer's own
 * transaction. A file still holding the card's stamp is stored as trusted. A file that changed since
 * trusts nothing and returns the card to raise afresh with the new stamp; a file gone returns none.
 * Any other card or choice is left alone.
 */
export function applyTrustChoice(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): FlagInput | null {
  if (item.kind !== InboxKind.Flag) return null;
  if (
    answer.choice !== TrustChoice.Trust &&
    answer.choice !== TrustChoice.Keep &&
    answer.choice !== GuardrailStrayChoice.Keep
  )
    return null;
  const path = item.detail?.[PATH_DETAIL];
  const root = item.detail?.[ROOT_DETAIL];
  const foldKey = item.detail?.[FOLD_DETAIL];
  const stamped = stampOf(item.detail);
  if (
    typeof foldKey !== 'string' ||
    typeof path !== 'string' ||
    typeof root !== 'string' ||
    stamped === null
  )
    return null;
  const now = stampFile(root, path);
  // A file gone has nothing to trust. One that is still there but can't be stamped (swapped for a link, grown
  // huge) is never closed silently: its card comes back with no trust choice.
  if (now === null && !existsAsEntry(join(root, path))) return null;
  if (now !== stamped) return changedSinceCard(item, root, foldKey, now);
  const kept = trustedWrites(ctx.tx, item.projectId).filter(
    (t) => !(t.path === path && t.sha256 === now),
  );
  setAppSetting(
    ctx,
    settingKey(item.projectId),
    [...kept, { path, sha256: now, trustedAt: ctx.now }].slice(-MAX_TRUSTED),
  );
  return null;
}
