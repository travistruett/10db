import { DeniedBy } from '@10db/contracts';
import type { DeniedCall } from '../trust';
import type { ClaudeDenial } from './claude-tool-calls';

/**
 * Who denied a call auto mode refused, as its tool call records it (sessions spec §5.2, trust line
 * §5). A limit is soft only where a person is in the session, whose policy renders the limits as
 * soft denies; the builder's go-ahead clears it. One of Claude Code's own safety checks, or a reason
 * that names no limit (one of auto mode's own rules), is hard.
 */
export function judgeDenial(call: DeniedCall, attended: boolean): ClaudeDenial {
  const limit = call.by === 'classifier' ? call.limit : null;
  return { by: DeniedBy.Judge, reason: call.reason, limit, soft: attended && limit !== null };
}
