import { ConversationState } from '@10db/contracts';
import { timerAt } from '../clock';
import type { EngineCore, Runtime } from './explore-runtime';

// Sessions spec §6.4: a conversation paused for its account's limit checks again at the
// pause's end, or at the next month's first instant for a cap, and on any change to the account.

export interface ExplorePauses {
  /** Arms the next check of a paused conversation's account. */
  armPause(rt: Runtime): void;
  /** Whether the account can run again: the queue runs if so, and the pause waits on if not. */
  recheckPause(rt: Runtime): void;
}

export function createPauses(core: EngineCore): ExplorePauses {
  const { clock } = core.deps;

  const armPause = (rt: Runtime): void => {
    rt.pauseTimer?.cancel();
    const now = clock.now();
    const at = rt.pausedUntil ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    rt.pauseTimer = timerAt(clock, at, () => {
      rt.pauseTimer = null;
      recheckPause(rt);
    });
  };

  /** A check that finds the account still blocked waits silently for the next. */
  const recheckPause = (rt: Runtime): void => {
    if (rt.state !== ConversationState.PausedAccount) return;
    const conv = core.conversation(rt.id);
    const blocked = core.deps.accountBlocked(core.accountOf(conv).id, conv.projectId);
    if (blocked === null) {
      rt.pauseTimer?.cancel();
      rt.pauseTimer = null;
      rt.pausedUntil = null;
      core.reduce(rt, { type: 'account_resumed' });
      rt.restartedWhilePaused = false;
      return;
    }
    rt.pausedUntil = blocked.until;
    if (rt.pauseTimer === null || blocked.until !== null) armPause(rt);
  };

  return { armPause, recheckPause };
}
