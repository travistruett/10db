import type { GuardVerdict } from '../guard';
import type { AgentSessionCore, JudgedCallRequest, ShapeVerdict } from './types';

/** An `allow` with no opinion: the guard left the call open, settling and rewriting nothing. */
function isBareAllow(verdict: ShapeVerdict): boolean {
  return (
    verdict.decision === 'allow' && !('updatedInput' in verdict) && verdict.settled === undefined
  );
}

/**
 * The session's answer for one call: the guard's verdict, or, when the guard left the call open and the session
 * has a judge, that judge's. A deny, an ask and a settled or rewritten allow stand as the guard gave them. A
 * judge that throws denies, naming 10db's guard, so a failure never lets the call run.
 */
export async function judgedVerdict<V extends ShapeVerdict>(
  spec: Pick<AgentSessionCore, 'judgeCall'>,
  verdict: V,
  req: JudgedCallRequest,
): Promise<V | GuardVerdict> {
  const { judgeCall } = spec;
  if (judgeCall === undefined || !isBareAllow(verdict)) return verdict;
  try {
    return await judgeCall(req);
  } catch (error) {
    const failed: GuardVerdict = {
      decision: 'deny',
      reason: `10db's guard failed: ${error instanceof Error ? error.message : String(error)}`,
    };
    return failed;
  }
}
