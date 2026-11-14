import {
  SKIP_SUMMARY_MAX,
  SkipKind,
  type LimitName,
  type SessionId,
  type SkipSource,
  type WorkstreamId,
} from '@10db/contracts';
import { recordSkip } from '@10db/db';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import type { TurnSkips } from './skip';

// T4 Task 4: one recorder per run. Every channel that skips a call (the guard, the broker, auto
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
}

export interface SkipRecorder {
  record(skip: RecordedSkip): void;
  /** A call of the turn was made; calls are ordered by when they are seen. */
  seen(toolUseId: string | null): void;
  /** What the turn skipped since the last `nextTurn`. */
  inTurn(): TurnSkips;
  nextTurn(): void;
}

export function createSkipRecorder(
  deps: { readonly state: StateStore; readonly log: Logger },
  run: { readonly workstreamId: WorkstreamId; readonly sessionId: SessionId | null },
): SkipRecorder {
  let order: string[] = [];
  let skipped = new Map<string, { readonly limit: LimitName | null; readonly reason: string }>();
  let unnamed = 0;
  return {
    record(skip) {
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
        }),
      );
      deps.log.info(
        { toolName: skip.toolName, kind: skip.kind, source: skip.source },
        'skipped a call',
      );
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
