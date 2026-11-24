import { DesignCheckPurpose, type SessionId, type TaskId } from '@10db/contracts';
import {
  getAccount,
  getSession,
  laneScreenBytesSentTo,
  listSessions,
  listTaskDesignChecks,
  type DbReader,
} from '@10db/db';
import { pictureLimitsFor, STRICTEST_LIMITS, type PictureLimits } from '../conversation';

/** The picture limits of the account a session runs on; the strictest when the session or account is gone. */
export function sessionPictureLimits(db: DbReader, sessionId: SessionId): PictureLimits {
  try {
    const session = getSession(db, sessionId);
    return pictureLimitsFor(getAccount(db, session.accountId).kind, {
      accountId: session.accountId,
      launchId: session.model,
    });
  } catch {
    return STRICTEST_LIMITS;
  }
}

/**
 * Picture bytes this session's conversation already carries as image blocks: the task's `check_design`
 * shots (each call's mock-ups, and its shots once, as its checks share a time), and the lane screens sent
 * to this session or to an earlier one with the same provider session id, since a resume carries them.
 */
export function lanePicturesSpent(
  db: DbReader,
  bytesOf: (sha256: string) => number,
  taskId: TaskId,
  sessionId: SessionId,
): number {
  const calls = new Map<string, { mockups: number; shots: number }>();
  for (const check of listTaskDesignChecks(db, taskId)) {
    if (check.purpose !== DesignCheckPurpose.LaneCheck) continue;
    const call = calls.get(check.createdAt) ?? { mockups: 0, shots: 0 };
    call.mockups += check.mockupSha256 === null ? 0 : bytesOf(check.mockupSha256);
    call.shots = check.shots.reduce((n, s) => n + (s.sha256 === null ? 0 : bytesOf(s.sha256)), 0);
    calls.set(check.createdAt, call);
  }
  const checks = [...calls.values()].reduce((n, c) => n + c.mockups + c.shots, 0);

  const own = getSession(db, sessionId);
  const sessions =
    own.workstreamId === null || own.providerSessionId === null
      ? [sessionId]
      : listSessions(db, own.workstreamId)
          .filter((s) => s.id === sessionId || s.providerSessionId === own.providerSessionId)
          .map((s) => s.id);
  return checks + laneScreenBytesSentTo(db, sessions);
}
