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
import { answeredLookRows, shadowReadingRows, type DbReader } from '@10db/db';
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
  let cleanButSentBack = 0;
  for (const card of answeredLookRows(db, projectId)) {
    const choice = card.answer.choice;
    if (choice !== WatchpointChoice.LooksRight && choice !== WatchpointChoice.SendBack) continue;
    const detail = WatchpointCardDetail.safeParse(card.detail);
    if (!detail.success) continue;
    // Readings are oldest first, so the last one taken before the answer is the one the card was raised on.
    const before = (byWorkstream.get(card.workstreamId) ?? []).filter(
      (r) => r.at <= card.answeredAt,
    );
    for (const { key } of detail.data.watchpoints) {
      const read = before
        .toReversed()
        .flatMap((r) => r.reads.filter((x) => x.key === key))
        .at(0);
      if (read === undefined || !wasAsked(read)) continue;
      scored += 1;
      if (choice === WatchpointChoice.LooksRight) {
        if (read.verdict === WatchpointReadVerdict.Clean) agreed += 1;
      } else if (holdsMerge(read.verdict)) agreed += 1;
      else if (read.verdict === WatchpointReadVerdict.Clean) cleanButSentBack += 1;
    }
  }
  return {
    firstAskedAt: firstAsked === null ? null : new Date(firstAsked),
    answered,
    scored,
    agreed,
    cleanButSentBack,
  };
}

/** How long the read stays in shadow before it may act: a week after its first read. */
const SHADOW_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Settings › Decisions' row for the watchpoint read: its shadow answers and how many agreed with what the builder
 * answered. `canShow` is whether the read may act, which is not the 20-scored rule of Shape's decisions: it is a week
 * since its first read with no clean read sent back.
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
    canShow:
      firstAskedAt !== null &&
      now.getTime() - firstAskedAt.getTime() >= SHADOW_WEEK_MS &&
      cleanButSentBack === 0,
  };
}
