import { BuilderToolName, ChatToolName } from '@10db/contracts';

// Sessions spec §6.6: which of a chat's tools run at once, which ask the builder and which the session's judge
// reads. Every one but the judged is in the session's `allowedTools`; the tool's own handler decides what asks,
// since only 10db knows which tasks the chat filed.

export const ChatToolPolicy = { Runs: 'runs', Asks: 'asks', Judged: 'judged' } as const;
export type ChatToolPolicy = (typeof ChatToolPolicy)[keyof typeof ChatToolPolicy];

const R = ChatToolPolicy.Runs;
const A = ChatToolPolicy.Asks;
const J = ChatToolPolicy.Judged;

/**
 * Removing a task the chat didn't file, and retiring, withdrawing or superseding a record, take the
 * builder's work away: limit 1, asked on a card. Everything else runs, `start_task` included, since
 * starting a task touches no limit.
 */
export const CHAT_TOOL_POLICY: Readonly<Record<ChatToolName, ChatToolPolicy>> = {
  [BuilderToolName.ListProjects]: R,
  [BuilderToolName.ListKinds]: R,
  [BuilderToolName.ListTasks]: R,
  [BuilderToolName.CreateTask]: R,
  [BuilderToolName.EditTask]: R,
  [BuilderToolName.RemoveTask]: A,
  [BuilderToolName.StartTask]: R,
  [BuilderToolName.MoveTask]: R,
  [BuilderToolName.RunNext]: R,
  [BuilderToolName.ListInbox]: R,
  [BuilderToolName.StartShape]: R,
  [BuilderToolName.ImportPlan]: R,
  [BuilderToolName.SearchKnowledge]: R,
  [BuilderToolName.SaveDecision]: R,
  [BuilderToolName.SavePrinciple]: R,
  [BuilderToolName.SupersedeKnowledge]: A,
  [BuilderToolName.RetireKnowledge]: A,
  [BuilderToolName.WithdrawKnowledge]: A,
  [BuilderToolName.ListProposals]: R,
  [ChatToolName.SetTitle]: R,
  // The brief is kept in memory for Do It's sheet and changes nothing on disk.
  [ChatToolName.WriteBrief]: R,
  // Branching, switching, pulling and committing change what the builder has in Your folder only while the turn
  // holds it, and run at once like the edits they follow.
  [ChatToolName.MakeBranch]: R,
  [ChatToolName.SwitchBranch]: R,
  [ChatToolName.Pull]: R,
  [ChatToolName.CommitChanges]: R,
  // These reach GitHub, so they stay out of `allowedTools` and the session's judge sees each call.
  [ChatToolName.PushBranch]: J,
  [ChatToolName.OpenPullRequest]: J,
  [ChatToolName.MergePullRequest]: J,
};
