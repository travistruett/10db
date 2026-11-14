import { JudgeOutcome, type JudgeDecision } from '@10db/contracts';
import { getJudgeConfig, insertJudgeCall } from '@10db/db';
import type { StateStore } from '../src/events';
import type { Judge, JudgeAnswer, JudgeRequest } from '../src/judge';

/** What a scripted decision answers: a choice with its confidence, or a fallback for the reason. */
export type ScriptedAnswer =
  | { readonly choice: string; readonly confidence: number }
  | { readonly fallback: 'timeout' | 'error' };

/**
 * A judge that answers from a script and logs each call as the real one does: a row whose outcome is
 * provisional (`acted` at or above the decision's floor, else `below_floor`), or the fallback's. The script
 * may return a promise a test holds back, or throw. Nothing reaches a network.
 */
export function scriptedJudge(
  state: StateStore,
  script: (req: JudgeRequest) => ScriptedAnswer | Promise<ScriptedAnswer>,
): Judge & { readonly requests: JudgeRequest[]; asked(decision: JudgeDecision): JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    off: false,
    requests,
    asked: (decision) => requests.filter((r) => r.decision === decision),
    async choose(req): Promise<JudgeAnswer> {
      requests.push(req);
      const scripted = await script(req);
      const floor = getJudgeConfig(state.db).decisions[req.decision].floor;
      const answered = 'choice' in scripted;
      const callId = state.write((ctx) =>
        insertJudgeCall(ctx, {
          decision: req.decision,
          model: 'scripted',
          state: req.state,
          question: req.question,
          answer: answered ? scripted.choice : null,
          confidence: answered ? scripted.confidence : null,
          outcome: !answered
            ? scripted.fallback === 'timeout'
              ? JudgeOutcome.FallbackTimeout
              : JudgeOutcome.FallbackError
            : scripted.confidence >= floor
              ? JudgeOutcome.Acted
              : JudgeOutcome.BelowFloor,
          latencyMs: 1,
          costUsd: null,
          workstreamId: null,
          taskId: req.taskId ?? null,
        }),
      );
      return answered
        ? {
            kind: 'answered',
            choice: scripted.choice,
            confidence: scripted.confidence,
            model: 'scripted',
            latencyMs: 1,
            costUsd: null,
            callId,
          }
        : { kind: 'fallback', reason: scripted.fallback, detail: scripted.fallback, callId };
    },
  };
}
