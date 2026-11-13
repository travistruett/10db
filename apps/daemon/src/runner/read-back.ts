import { agentKind, type NextAction, type TaskId, type WorkstreamId } from '@10db/contracts';
import {
  insertSystemNotice,
  listUndeliveredTaskMessages,
  markTaskMessagesTakenUnder,
  patchWorkstream,
  type AccountRow,
} from '@10db/db';
import { AccountLaunchError, KeychainError, type Launcher } from '../environment';
import type { StateStore } from '../events';
import { ConversationUnreadError, type AgentAdapter } from '../sessions';
import { resumedSessionOf } from './next-action';

// Workbench spec §12. A lane that resumes a Codex thread while a builder message pushed to it was never
// seen taken (the daemon restarted, or the session was stopped, before the event saying so was read)
// cannot tell from its rows whether a turn took it, so the thread itself is read back first. A message
// pushed under a client uuid the thread took is delivered and never sent again, and a `feedback` whose
// message was taken resumes the thread without it; any other is sent again. A thread that can't be
// read is not guessed at: the lane starts a fresh session, which is sent the message again under a
// uuid of its own (at least once, as a resumed Claude Code session is), and the thread says so. What
// the read decides is kept in one write, so a launch that goes no further never decides it again.

/** Why a lane resumes a thread whose turn took the message it was to bring. */
export const TURN_CUT_SHORT = 'the turn that took the message was cut short';

/** Said on the thread when its Codex conversation can't be read back. */
export const THREAD_UNREAD_NOTICE =
  "Couldn't read the Codex conversation after the restart; your message was sent again in a fresh session";

export type ReadBack =
  /** The action to launch, as kept on the workstream. */
  | { readonly kind: 'read'; readonly action: NextAction }
  /** The lane was stopped during the read: nothing was decided. */
  | { readonly kind: 'stopped' };

export interface ReadBackDeps {
  readonly state: StateStore;
  readonly adapter: Pick<AgentAdapter, 'readClientUuids' | 'capabilities'>;
  readonly launcher: Pick<Launcher, 'probe'>;
}

/**
 * Reads back the Codex thread `action` resumes when the task has a builder message pushed under a
 * client uuid and never seen taken. Reads nothing for a Claude account, a fresh session or no such
 * message. `onUnread` is the action of a fresh session, launched when the thread can't be read.
 */
export async function readBackThread(
  deps: ReadBackDeps,
  input: {
    readonly workstreamId: WorkstreamId;
    readonly fence: number | null;
    readonly taskId: TaskId;
    readonly account: AccountRow;
    readonly cwd: string;
    readonly action: NextAction;
    readonly onUnread: NextAction;
    readonly signal?: AbortSignal;
  },
): Promise<ReadBack> {
  const { action } = input;
  const thread = resumedSessionOf(action);
  const unchanged: ReadBack = { kind: 'read', action };
  if (
    thread === null ||
    !deps.adapter.capabilities({ kind: agentKind(input.account.kind) }, null).readBack
  )
    return unchanged;
  // Oldest first, so the first was written earliest.
  const inDoubt = listUndeliveredTaskMessages(deps.state.db, input.taskId).filter(
    (m) => m.pushUuids.length > 0,
  );
  const [oldest] = inDoubt;
  if (oldest === undefined) return unchanged;
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
      wanted: inDoubt.flatMap((m) => m.pushUuids),
      since: oldest.createdAt,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (!(error instanceof ConversationUnreadError)) throw error;
    if (input.signal?.aborted === true) return { kind: 'stopped' };
    deps.state.write((ctx) => {
      insertSystemNotice(ctx, input.taskId, THREAD_UNREAD_NOTICE);
      patchWorkstream(ctx, input.workstreamId, input.fence, { nextAction: input.onUnread });
    });
    return { kind: 'read', action: input.onUnread };
  }
  const decided = deps.state.write((ctx): NextAction => {
    const taken = markTaskMessagesTakenUnder(ctx, input.taskId, held);
    if (action.kind !== 'feedback' || !taken.includes(action.messageId)) return action;
    const resumed: NextAction = {
      kind: 'resume',
      providerSessionId: thread,
      reason: TURN_CUT_SHORT,
    };
    patchWorkstream(ctx, input.workstreamId, input.fence, { nextAction: resumed });
    return resumed;
  });
  return { kind: 'read', action: decided };
}
