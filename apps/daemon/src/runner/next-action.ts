import type { EvidenceId, HandoffDto, NextAction, TaskMessageId } from '@10db/contracts';

/**
 * After a crash: resume the provider session once; if resuming already failed, start fresh from the
 * last handoff. A gate failure is builder input the next session must still see, so it survives the
 * crash, retried until the recovery limit fails the workstream. An answer survives only a crash before
 * its session started: once a session has started, the runner has replaced the `answer` action, so the
 * answer and a one-time permission reach exactly one session. Uncommitted changes survive the same way:
 * the step still has to commit them. A builder's message survives until a turn takes it: a fresh session
 * that crashed is resumed once, and a resumed one that crashed gives way to a fresh session from the
 * thread's digest (Workbench spec §6.3).
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
    case 'merge':
    case 'builder_review':
      return previous;
    case 'answer':
      return { ...previous, providerSessionId: providerSessionId ?? previous.providerSessionId };
    case 'feedback':
      return {
        ...previous,
        providerSessionId: previous.providerSessionId === null ? providerSessionId : null,
      };
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
 * starts fresh as after a failed resume, from the step's latest handoff. The builder's answer and message
 * still reach the fresh session, and so does a gate failure the lane was fixing.
 */
export function nextActionOnAnotherAccount(
  previous: NextAction,
  latest: HandoffDto | null,
  failedGate: EvidenceId | null,
): NextAction {
  switch (previous.kind) {
    case 'answer':
    case 'feedback':
      return { ...previous, providerSessionId: null };
    case 'resume':
      return failedGate
        ? { kind: 'fix', evidenceId: failedGate }
        : nextActionAfterCrash(previous, null, latest);
    case 'start':
    case 'continue_from_handoff':
    case 'fix':
    case 'uncommitted':
    case 'merge':
    case 'verify':
    case 'revise':
    case 'builder_review':
      return previous;
  }
}

/**
 * The next action once a session has ended with a builder message handed to it and never taken by a
 * turn: `messageId`, the oldest such, or null when there is none (Workbench spec §6.3). The message
 * starts the next session, resuming the conversation the action would resume, else fresh from the
 * thread's digest. An action that brings its own builder input or verification keeps it; the next
 * session is handed the message after its prompt.
 */
export function withUndelivered(next: NextAction, messageId: TaskMessageId | null): NextAction {
  if (messageId === null) return next;
  switch (next.kind) {
    case 'resume':
    case 'feedback':
      return { kind: 'feedback', messageId, providerSessionId: next.providerSessionId };
    case 'start':
    case 'continue_from_handoff':
      return { kind: 'feedback', messageId, providerSessionId: null };
    case 'answer':
    case 'fix':
    case 'uncommitted':
    case 'merge':
    case 'verify':
    case 'revise':
    case 'builder_review':
      return next;
  }
}

/** The provider session the action resumes, or null for one that starts a fresh session. */
export function resumedSessionOf(action: NextAction): string | null {
  switch (action.kind) {
    case 'resume':
    case 'answer':
    case 'feedback':
      return action.providerSessionId;
    case 'start':
    case 'continue_from_handoff':
    case 'fix':
    case 'uncommitted':
    case 'merge':
    case 'verify':
    case 'revise':
    case 'builder_review':
      return null;
  }
}
