import type { HandoffDto, NextAction } from '@10db/contracts';

/**
 * After a crash: resume the provider session once; if resuming already failed, start fresh from the
 * last handoff. A gate failure is builder input the next session must still see, so it survives the
 * crash, retried until the recovery limit fails the workstream. An answer survives only a crash before
 * its session started: once a session has started, the runner has replaced the `answer` action, so the
 * answer and a one-time permission reach exactly one session.
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
