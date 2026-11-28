import {
  JudgeDecision,
  StoredWatchpointDetail,
  WatchpointCardDetail,
  WatchpointChoice,
  WatchpointReadVerdict,
  type ProjectId,
  type ShadowAgreementDto,
  type WatchpointRead,
  type WorkstreamId,
} from '@10db/contracts';
import { answeredLookRows, getAppSetting, shadowReadingRows, type DbReader } from '@10db/db';
import { z } from 'zod';
import { holdsMerge } from './read';

/** One shadow reading of a workstream: when it was taken and the reads it kept in shadow. */
interface ShadowReading {
  readonly at: string;
  readonly reads: readonly WatchpointRead[];
}

/** Whether the judge was asked: `unread` had no judge and `hold` needs none, so neither is scored. */
function wasAsked(read: WatchpointRead): boolean {
  return (
    read.verdict !== WatchpointReadVerdict.Unread && read.verdict !== WatchpointReadVerdict.Hold
  );
}

/**
 * How often the judge's reads, kept in shadow, agreed with what the builder answered on the task's Look card.
 * A `clean` read agrees with Looks Right, and a read that holds a merge (`holdsMerge`) agrees with Send Back.
 * Only a read of a watchpoint the answered card named is scored, against the newest reading taken before the
 * answer. `cleanButSentBack` counts the clean reads the builder sent back. `firstAskedAt` is when the oldest read the
 * judge was asked for was taken, whether or not its card is answered yet. `answered` counts the reads asked in shadow
 * that got an answer, whether or not their card is answered. `projectId` null counts every project.
 */
export function watchpointReadAgreement(
  db: DbReader,
  projectId: ProjectId | null,
): {
  firstAskedAt: Date | null;
  answered: number;
  scored: number;
  agreed: number;
  cleanButSentBack: number;
  /** The clean reads the builder sent back, for the card that names them. */
  sentBack: { workstreamId: WorkstreamId; label: string }[];
} {
  const byWorkstream = new Map<WorkstreamId, ShadowReading[]>();
  let firstAsked: string | null = null;
  let answered = 0;
  for (const row of shadowReadingRows(db, projectId)) {
    const reads = (StoredWatchpointDetail.parse(row.detail).reads ?? []).filter((r) => !r.acted);
    if (reads.length === 0) continue;
    const readings = byWorkstream.get(row.workstreamId) ?? [];
    readings.push({ at: row.createdAt, reads });
    byWorkstream.set(row.workstreamId, readings);
    answered += reads.filter((r) => wasAsked(r) && r.meets !== null).length;
    if (reads.some(wasAsked) && (firstAsked === null || row.createdAt < firstAsked))
      firstAsked = row.createdAt;
  }

  let scored = 0;
  let agreed = 0;
  const sentBack: { workstreamId: WorkstreamId; label: string }[] = [];
  for (const card of answeredLookRows(db, projectId)) {
    const choice = card.answer.choice;
    if (choice !== WatchpointChoice.LooksRight && choice !== WatchpointChoice.SendBack) continue;
    const detail = WatchpointCardDetail.safeParse(card.detail);
    if (!detail.success) continue;
    // Readings are oldest first, so the last one taken before the answer is the one the card was raised on.
    const before = (byWorkstream.get(card.workstreamId) ?? []).filter(
      (r) => r.at <= card.answeredAt,
    );
    for (const { key, label } of detail.data.watchpoints) {
      const read = before
        .toReversed()
        .flatMap((r) => r.reads.filter((x) => x.key === key))
        .at(0);
      if (read === undefined || !wasAsked(read)) continue;
      scored += 1;
      if (choice === WatchpointChoice.LooksRight) {
        if (read.verdict === WatchpointReadVerdict.Clean) agreed += 1;
      } else if (holdsMerge(read.verdict)) agreed += 1;
      else if (read.verdict === WatchpointReadVerdict.Clean)
        sentBack.push({ workstreamId: card.workstreamId, label });
    }
  }
  return {
    firstAskedAt: firstAsked === null ? null : new Date(firstAsked),
    answered,
    scored,
    agreed,
    cleanButSentBack: sentBack.length,
    sentBack,
  };
}

/** How long the read stays in shadow before it may act: a week after its first read. */
const SHADOW_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether the judge's read of a watchpoint hit acts, and whether the builder is to be asked about it, first match
 * wins: the builder's yes acts and their no does not, a read less than a week old (or never asked) stays in shadow,
 * a clean read the builder sent back keeps it in shadow and asks once, and otherwise it acts. No minimum count of
 * scored reads: a project with no Ask hits that week has nothing to disagree with.
 */
export function readActs(input: {
  readonly firstAskedAt: Date | null;
  readonly cleanButSentBack: number;
  /** The builder's answer to the disagreement card; null: never asked. */
  readonly allowed: boolean | null;
  readonly now: Date;
}): { readonly acts: boolean; readonly ask: boolean } {
  if (input.allowed === true) return { acts: true, ask: false };
  if (input.allowed === false) return { acts: false, ask: false };
  if (
    input.firstAskedAt === null ||
    input.now.getTime() - input.firstAskedAt.getTime() < SHADOW_WEEK_MS
  )
    return { acts: false, ask: false };
  if (input.cleanButSentBack > 0) return { acts: false, ask: true };
  return { acts: true, ask: false };
}

/** The app setting that holds a project's answer to the disagreement card. */
export const readAllowedKey = (projectId: ProjectId): string =>
  `watchpoint-read.allowed.${projectId}`;

/** The builder's answer for the project: null when never asked or the stored value is not a boolean. */
export function readAllowed(db: DbReader, projectId: ProjectId): boolean | null {
  const parsed = z.boolean().safeParse(getAppSetting(db, readAllowedKey(projectId)));
  return parsed.success ? parsed.data : null;
}

/** Whether the project's read acts, and whether the builder is to be asked, as of `now`. */
export function projectReadActs(
  db: DbReader,
  projectId: ProjectId,
  now: Date,
): ReturnType<typeof readActs> {
  const { firstAskedAt, cleanButSentBack } = watchpointReadAgreement(db, projectId);
  return readActs({ firstAskedAt, cleanButSentBack, allowed: readAllowed(db, projectId), now });
}

/**
 * Settings › Decisions' row for the watchpoint read: its shadow answers and how many agreed with what the builder
 * answered. `canShow` is whether the read may act, which is not the 20-scored rule of Shape's decisions: it is
 * `readActs` over every project, with no builder answer to count (each project's own answer decides its reads).
 */
export function watchpointReadRow(db: DbReader, now: Date): ShadowAgreementDto {
  const { firstAskedAt, answered, scored, agreed, cleanButSentBack } = watchpointReadAgreement(
    db,
    null,
  );
  return {
    decision: JudgeDecision.WatchpointRead,
    answered,
    scored,
    agreed,
    canShow: readActs({ firstAskedAt, cleanButSentBack, allowed: null, now }).acts,
  };
}
