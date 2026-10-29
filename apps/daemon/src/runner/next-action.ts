import type { EvidenceId, HandoffDto, NextAction } from '@10db/contracts';

/**
 * After a crash: resume the provider session once; if resuming already failed, start fresh from the
 * last handoff. A gate failure is builder input the next session must still see, so it survives the
 * crash, retried until the recovery limit fails the workstream. An answer survives only a crash before
 * its session started: once a session has started, the runner has replaced the `answer` action, so the
 * answer and a one-time permission reach exactly one session. Uncommitted changes survive the same way:
 * the step still has to commit them.
 */
export function nextActionAfterCrash(
  previous: NextAction,
  providerSessionId: string | null,
  latest: HandoffDto | null,
): NextAction {
  const fresh: NextAction = latest
    ? { kind: 'continue_from_handoff', handoffId: latest.id }
    : { kind: 'start' };
  switch (previous.kind) {
    case 'verify':
    case 'fix':
    case 'revise':
    case 'uncommitted':
    case 'builder_review':
      return previous;
    case 'answer':
      return { ...previous, providerSessionId: providerSessionId ?? previous.providerSessionId };
    case 'resume':
      return fresh;
    case 'start':
    case 'continue_from_handoff':
      return providerSessionId
        ? { kind: 'resume', providerSessionId, reason: 'the session crashed' }
        : fresh;
  }
}

/**
 * Before a session on the project's account, when the conversation the lane would resume ran on
 * another one: Claude Code keeps a conversation in its account's config directory, so the lane
 * starts fresh as after a failed resume, from the step's latest handoff. The builder's answer still
 * reaches the fresh session, and so does a gate failure the lane was fixing.
 */
export function nextActionOnAnotherAccount(
  previous: NextAction,
  latest: HandoffDto | null,
  failedGate: EvidenceId | null,
): NextAction {
  switch (previous.kind) {
    case 'answer':
      return { ...previous, providerSessionId: null };
    case 'resume':
      return failedGate
        ? { kind: 'fix', evidenceId: failedGate }
        : nextActionAfterCrash(previous, null, latest);
    case 'start':
    case 'continue_from_handoff':
    case 'fix':
    case 'uncommitted':
    case 'verify':
    case 'revise':
    case 'builder_review':
      return previous;
  }
}
