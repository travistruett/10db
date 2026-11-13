import { DeniedBy } from '@10db/contracts';
import type { DeniedCall } from '../trust';
import type { ClaudeDenial } from './claude-tool-calls';

/**
 * Who denied a call auto mode refused, as its tool call records it (sessions spec §5.2, trust line
 * §5). Where a person is in the session every classifier denial is soft: the builder's go-ahead may
 * clear it (Allow this), as Claude Code lets the user approve what auto mode blocked, whether or not
 * the reason names a limit. In a session no one is in, and for one of Claude Code's own safety
 * checks, it is hard.
 */
export function judgeDenial(call: DeniedCall, attended: boolean): ClaudeDenial {
  const classifier = call.by === 'classifier';
  return {
    by: DeniedBy.Judge,
    reason: call.reason,
    limit: classifier ? call.limit : null,
    soft: attended && classifier,
  };
}
