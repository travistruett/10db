import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
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
import { BY_ANSWER, CardTier } from './card-tier';
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

/** A file bigger than this is not stamped, so its card offers no trust and no answer reads it whole. */
const MAX_STAMPED_BYTES = 32 * 1024 * 1024;
/** The most trusted writes kept per project; the oldest go first. */
const MAX_TRUSTED = 500;

const TrustedWrite = z.object({ path: z.string(), sha256: z.string(), trustedAt: z.string() });
export type TrustedWrite = z.infer<typeof TrustedWrite>;
const TrustedWrites = z.array(TrustedWrite);

const settingKey = (projectId: ProjectId): string => `trusted_writes.${projectId}`;

/** The sha256 of a regular file in a checkout; null for a missing file, a link, a directory or a huge file. */
export function stampFile(root: string, rel: string): string | null {
  const path = join(root, rel);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_STAMPED_BYTES) return null;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** What a stray-write card carries so its answer can trust the version it showed. */
export function stampDetail(root: string, sha256: string, foldKey: string): Record<string, Json> {
  return { [ROOT_DETAIL]: root, [SHA_DETAIL]: sha256, [FOLD_DETAIL]: foldKey };
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
  if (answer.choice !== TrustChoice.Trust && answer.choice !== TrustChoice.Keep) return null;
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
  if (now === null) return null;
  if (now !== stamped) {
    return {
      projectId: item.projectId,
      tier: CardTier.Ask,
      urgency: item.urgency,
      closesWhen: BY_ANSWER,
      workstreamId: item.targets[0]?.workstreamId ?? null,
      title: item.title,
      body: item.body,
      detail: { ...item.detail, ...stampDetail(root, now, foldKey) },
      options: item.options,
      foldKey,
    };
  }
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
