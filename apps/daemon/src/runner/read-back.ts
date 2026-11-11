import { Provider, providerOf, type NextAction, type TaskId } from '@10db/contracts';
import { listUndeliveredTaskMessages, markTaskMessagesTakenUnder, type AccountRow } from '@10db/db';
import { AccountLaunchError, KeychainError, type Launcher } from '../environment';
import type { StateStore } from '../events';
import { ConversationUnreadError, type SessionAdapter } from '../sessions';
import { resumedSessionOf } from './next-action';

// Workbench spec §12. A daemon that died while a builder message was on its way into a Codex thread
// cannot tell from its rows whether a turn took it: the event saying so died with it. Before the lane
// resumes the thread, the thread itself is read back. A message pushed under a client uuid the thread
// holds was taken, and is delivered; any other is sent again; a thread that cannot be read is never
// guessed at. A resumed Claude Code session is pushed the message again, which at-least-once allows.

/** Why a lane resumes a thread that took the message it was to bring. */
export const TAKEN_BEFORE_RESTART = '10db restarted during the turn that took the message';

export type ReadBack =
  | {
      readonly kind: 'read';
      /** The action to launch: a `feedback` whose message the thread took resumes it instead. */
      readonly action: NextAction;
    }
  | { readonly kind: 'unread'; readonly message: string };

export interface ReadBackDeps {
  readonly state: StateStore;
  readonly adapter: Pick<SessionAdapter, 'readClientUuids'>;
  readonly launcher: Pick<Launcher, 'probe'>;
}

/**
 * Reads back the Codex thread `action` resumes, when the task has a builder message pushed under a
 * client uuid and never seen taken; marks delivered each such message the thread took. Reads
 * nothing for a Claude account, a fresh session or no such message.
 */
export async function readBackThread(
  deps: ReadBackDeps,
  input: {
    readonly taskId: TaskId;
    readonly account: AccountRow;
    readonly cwd: string;
    readonly action: NextAction;
  },
): Promise<ReadBack> {
  const { action } = input;
  const thread = resumedSessionOf(action);
  const unchanged: ReadBack = { kind: 'read', action };
  if (thread === null || providerOf(input.account.kind) !== Provider.Codex) return unchanged;
  const inDoubt = listUndeliveredTaskMessages(deps.state.db, input.taskId).some(
    (m) => m.pushUuids.length > 0,
  );
  if (!inDoubt) return unchanged;
  let launch;
  try {
    launch = deps.launcher.probe(input.account);
  } catch (error) {
    // The launch that follows refuses the account for the same reason, and holds it.
    if (error instanceof AccountLaunchError || error instanceof KeychainError) return unchanged;
    throw error;
  }
  let held: readonly string[];
  try {
    held = await deps.adapter.readClientUuids({
      account: launch.expect,
      env: launch.env,
      cwd: input.cwd,
      providerSessionId: thread,
    });
  } catch (error) {
    if (!(error instanceof ConversationUnreadError)) throw error;
    return {
      kind: 'unread',
      message: `${error.message}, so 10db cannot tell whether a turn took the builder's message before 10db restarted. Retry Turn sends it again.`,
    };
  }
  const taken = deps.state.write((ctx) => markTaskMessagesTakenUnder(ctx, input.taskId, held));
  if (action.kind === 'feedback' && taken.includes(action.messageId))
    return {
      kind: 'read',
      action: { kind: 'resume', providerSessionId: thread, reason: TAKEN_BEFORE_RESTART },
    };
  return unchanged;
}
