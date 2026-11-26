import {
  Approval,
  approvalOf,
  SKIP_SUMMARY_MAX,
  SkipKind,
  SkipSource,
  type LimitName,
  type SessionId,
  type WorkstreamId,
} from '@10db/contracts';
import { recordSkip } from '@10db/db';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import type { TurnSkips } from './skip';

// One recorder per run. Every channel that skips a call (the guard, the broker, auto
// mode's denials, the host judge) or answers a question records it here once, and the turn's last
// call is read by the order the calls were made in, not the order their reports arrive.

export interface RecordedSkip {
  readonly toolName: string;
  readonly toolUseId: string | null;
  readonly callKey: string | null;
  readonly summary: string;
  readonly kind: SkipKind;
  readonly limit: LimitName | null;
  readonly reason: string;
  readonly source: SkipSource;
  /** The program the call runs (`programKey`); candidates for a standing approval are counted by it. */
  readonly programKey?: string | null;
}

export interface SkipRecorder {
  record(skip: RecordedSkip): void;
  /** A call of the turn was made; calls are ordered by when they are seen. */
  seen(toolUseId: string | null): void;
  /** What the turn skipped since the last `nextTurn`. */
  inTurn(): TurnSkips;
  nextTurn(): void;
}

const CANT_RUN_REASON =
  "This program is outside what a lane's sandbox reads, so it can't run in this lane's sandbox.";

export function createSkipRecorder(
  deps: {
    readonly state: StateStore;
    readonly log: Logger;
    /** Whether a shell call's program can run under the lane's profile; absent, every program can. */
    readonly runnable?: (command: string) => boolean;
    /**
     * Told after 10db's judge's doubt skip (no limit, a program key) is written, so the project's standing
     * approval candidates can be read again. Bookkeeping: it never fails the record.
     */
    readonly onDoubtSkip?: () => void;
  },
  run: { readonly workstreamId: WorkstreamId; readonly sessionId: SessionId | null },
): SkipRecorder {
  let order: string[] = [];
  let skipped = new Map<string, { readonly limit: LimitName | null; readonly reason: string }>();
  let unnamed = 0;
  // A shell call whose program the lane's profile can't read is a skip no approval can clear.
  const laneCantRun = (skip: RecordedSkip): RecordedSkip =>
    deps.runnable !== undefined &&
    skip.toolName === 'Bash' &&
    skip.summary.length <= SKIP_SUMMARY_MAX &&
    // Only a call that would have run on approval, with no limit named: a hazard, secret or safety skip
    // keeps its own kind and reason.
    skip.limit === null &&
    (approvalOf(skip.kind, false) === Approval.Intent ||
      approvalOf(skip.kind, false) === Approval.Exact) &&
    !deps.runnable(skip.summary)
      ? { ...skip, kind: SkipKind.CantRunInLane, reason: `${CANT_RUN_REASON} (${skip.reason})` }
      : skip;
  return {
    record(recorded) {
      const skip = laneCantRun(recorded);
      const cut = skip.summary.length > SKIP_SUMMARY_MAX;
      deps.state.write((ctx) =>
        recordSkip(ctx, {
          workstreamId: run.workstreamId,
          sessionId: run.sessionId,
          toolName: skip.toolName,
          toolUseId: skip.toolUseId,
          callKey: skip.callKey,
          summary: cut ? `${skip.summary.slice(0, SKIP_SUMMARY_MAX)}…` : skip.summary,
          summaryCut: cut,
          kind: skip.kind,
          limit: skip.limit,
          reason: skip.reason,
          source: skip.source,
          programKey: skip.programKey ?? null,
        }),
      );
      deps.log.info(
        { toolName: skip.toolName, kind: skip.kind, source: skip.source },
        'skipped a call',
      );
      if (
        skip.source === SkipSource.TendbJudge &&
        skip.kind === SkipKind.Classifier &&
        skip.limit === null &&
        skip.programKey !== undefined &&
        skip.programKey !== null
      ) {
        try {
          deps.onDoubtSkip?.();
        } catch (error) {
          deps.log.warn({ err: error }, 'the standing approval candidates were not refreshed');
        }
      }
      // A question was answered, not skipped: it never stops a turn.
      if (skip.kind === SkipKind.Question) return;
      // A skip no call id names is a call of its own, made now.
      const id = skip.toolUseId ?? `\0unnamed-${String((unnamed += 1))}`;
      if (skip.toolUseId === null) order.push(id);
      skipped.set(id, { limit: skip.limit, reason: skip.reason });
    },
    seen(toolUseId) {
      if (toolUseId !== null && !order.includes(toolUseId)) order.push(toolUseId);
    },
    inTurn() {
      const lastId = order.at(-1);
      const last = lastId === undefined ? undefined : skipped.get(lastId);
      const latest = [...skipped.values()].at(-1) ?? null;
      return { lastCallSkipped: last !== undefined, last: last ?? latest, skips: skipped.size };
    },
    nextTurn() {
      order = [];
      skipped = new Map();
    },
  };
}
