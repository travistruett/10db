import {
  JudgeKind,
  SkipKind,
  SkipSource,
  type ProjectId,
  type TaskId,
  type TrustPolicy,
  type WorkstreamId,
} from '@10db/contracts';
import { z } from 'zod';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import type { GuardVerdict } from '../guard';
import type { Judge } from '../judge';
import type { Logger } from '../log';
import type { JudgedCallRequest } from '../sessions';
import {
  callKey,
  callSummary,
  crossesLimit,
  isGrantedCall,
  projectGrantedCalls,
  skipMessage,
  type FastPathContext,
  type LimitAt,
  type SkipRecorder,
} from '../trust';

/** How long after 10db's judge timed out or failed its calls go straight to the rules, so a down OpenRouter costs one wait. */
export const FLOOR_BACKOFF_MS = 60_000;

/** The most tool use ids whose limits are kept for their cards; the oldest is dropped first. */
const NOTED_IDS_MAX = 256;

/**
 * The limits 10db's judge stopped calls at, by tool use id, for the card the broker raises next. A Codex patch
 * can note one id once per file, so each id keeps a queue and `take` answers the oldest.
 */
export interface LimitNotes {
  note(toolUseId: string, at: LimitAt): void;
  take(toolUseId: string): LimitAt | undefined;
}

export function createLimitNotes(): LimitNotes {
  const noted = new Map<string, LimitAt[]>();
  return {
    note(toolUseId, at) {
      const queue = noted.get(toolUseId);
      if (queue !== undefined) {
        queue.push(at);
        return;
      }
      noted.set(toolUseId, [at]);
      if (noted.size > NOTED_IDS_MAX) {
        const [oldest] = noted.keys();
        if (oldest !== undefined) noted.delete(oldest);
      }
    },
    take(toolUseId) {
      const queue = noted.get(toolUseId);
      const at = queue?.shift();
      if (queue?.length === 0) noted.delete(toolUseId);
      return at;
    },
  };
}

export interface HookJudgeContext {
  readonly projectId: ProjectId;
  readonly workstreamId: WorkstreamId | null;
  readonly taskId: TaskId | null;
  readonly fastPath: FastPathContext;
  readonly policy: TrustPolicy;
  /** The builder's approved calls and the project's grants as they are now, so a grant removed mid-session stops at once. */
  readonly allowLines: () => readonly string[];
  /** The judge of this call: only a `tendb` call is 10db's judge's. */
  readonly judgeNow: (req: JudgedCallRequest) => JudgeKind;
  /**
   * Whether the builder's own allowed commands (the project's, never a step's base list) cover the call: it is
   * settled before any judge reads it, as Claude Code's allow rule settles it on native.
   */
  readonly coveredByBuilderRule: (req: JudgedCallRequest) => boolean;
  /** The session's own answer on the `rules` floor, a lane's unattended answer and skip included. */
  readonly floorVerdict: (req: JudgedCallRequest) => GuardVerdict;
  /** A lane's skip recorder; null where the builder is in the session. */
  readonly skips: SkipRecorder | null;
  readonly limits: LimitNotes;
  /** Told each time 10db's judge can't answer, with what it said: the thread's notice and the log. */
  readonly onFloor: (detail: string) => void;
  readonly clock: Clock;
}

const FAST_PATH_SETTLED = 'A read, an edit or a read-only command that reaches no secret';
const MODEL_SETTLED = "Allowed by 10db's judge";
const RULE_SETTLED = "The builder's allow rule covers this call, so it runs, as in Claude Code.";
const GRANT_SETTLED = 'The builder allowed this very call in this project.';

const InputRecord = z.record(z.string(), z.unknown());

/**
 * The session judge for a call the guard left open, on 10db's judge: the fast path, then `crossesLimit`. An allow
 * settles the call; a limit asks the builder (attended) or is a recorded skip (a lane); a judge that can't answer
 * gives the session's rules answer, and for `FLOOR_BACKOFF_MS` after a timeout or an error asks no model.
 */
export function createHookJudge(
  deps: { readonly judge: Judge; readonly state: StateStore; readonly logger: Logger },
  ctx: HookJudgeContext,
): (req: JudgedCallRequest) => Promise<GuardVerdict> {
  let downAt: { readonly ms: number; readonly detail: string } | null = null;

  const floor = (req: JudgedCallRequest, detail: string): GuardVerdict => {
    ctx.onFloor(detail);
    deps.logger.info(
      { workstreamId: ctx.workstreamId, toolName: req.toolName, detail },
      "10db's judge didn't answer; the rules decide this call",
    );
    return ctx.floorVerdict(req);
  };

  return async (req) => {
    const judging = ctx.judgeNow(req);
    if (judging === JudgeKind.Rules) return { decision: 'allow' };
    // A question is the builder's to answer, whatever any judge thinks of it.
    if (req.toolName === 'AskUserQuestion') return { decision: 'allow' };
    const input = InputRecord.safeParse(req.input).data ?? {};
    // The builder's Always in this project on this very call settles it in the hook, ahead of Claude's auto
    // mode classifier as well as 10db's judge: the hook's allow ends the check, as Claude Code's own "don't ask
    // again" does. No judge reads the call, since it is the agent's text.
    if (isGrantedCall(projectGrantedCalls(deps.state.db, ctx.projectId), req.toolName, input))
      return { decision: 'allow', settled: GRANT_SETTLED };
    if (judging !== JudgeKind.Tendb) return { decision: 'allow' };
    if (ctx.coveredByBuilderRule(req)) return { decision: 'allow', settled: RULE_SETTLED };
    const now = ctx.clock.now().getTime();
    if (downAt !== null && now - downAt.ms < FLOOR_BACKOFF_MS) return floor(req, downAt.detail);
    const verdict = await crossesLimit(
      { judge: deps.judge, state: deps.state },
      {
        call: {
          toolName: req.toolName,
          input: req.input,
          cwd: req.cwd ?? ctx.fastPath.checkout,
          hunk: req.hunk,
        },
        fastPath: ctx.fastPath,
        policy: ctx.policy,
        allow: ctx.allowLines(),
        ...(ctx.workstreamId === null ? {} : { workstreamId: ctx.workstreamId }),
        ...(ctx.taskId === null ? {} : { taskId: ctx.taskId }),
        signal: req.signal,
      },
    );
    switch (verdict.kind) {
      case 'allow':
        downAt = null;
        return {
          decision: 'allow',
          settled: verdict.by === 'fast_path' ? FAST_PATH_SETTLED : MODEL_SETTLED,
        };
      case 'floor':
        if (verdict.reason === 'timeout' || verdict.reason === 'error')
          downAt = { ms: ctx.clock.now().getTime(), detail: verdict.detail };
        return floor(req, verdict.detail);
      case 'limit': {
        downAt = null;
        const { at } = verdict;
        if (ctx.skips === null) {
          // Without an id no card can be tied to the call, so it is refused with its reason.
          if (req.toolUseId === null)
            return { decision: 'deny', reason: at.reason, judged: { limit: at.limit } };
          ctx.limits.note(req.toolUseId, at);
          return { decision: 'ask', reason: `10db's judge asks the builder: ${at.reason}` };
        }
        ctx.skips.record({
          toolName: req.toolName,
          toolUseId: req.toolUseId,
          callKey: callKey(req.toolName, input, ctx.fastPath.checkout),
          summary: callSummary(req.toolName, input).text,
          kind: SkipKind.Classifier,
          limit: at.limit,
          reason: at.reason,
          source: SkipSource.TendbJudge,
        });
        return {
          decision: 'deny',
          reason: skipMessage(at.limit, at.reason),
          judged: { limit: at.limit },
        };
      }
    }
  };
}
