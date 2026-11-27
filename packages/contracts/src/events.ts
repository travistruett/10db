import { z } from 'zod';

export const EventType = {
  AccountSaved: 'account.saved',
  AccountCapReached: 'account.cap_reached',
  AccountPaused: 'account.paused',
  AccountResumed: 'account.resumed',
  /** An account's browser sign-in ended: it finished, failed, was cancelled or timed out. */
  AccountLoginEnded: 'account.login_ended',
  /** A gh sign-in ended (`GithubLoginEndedData`); the gh login is the Mac's, so no entity owns it. */
  GithubLoginEnded: 'github.login_ended',
  ProjectCreated: 'project.created',
  TaskCreated: 'task.created',
  TaskChanged: 'task.changed',
  /** A message joined a task's thread; `data.messageId` names it. */
  TaskMessageAdded: 'task.message_added',
  /** A picture of the task's page was kept (`TaskScreenAddedData`). */
  TaskScreenAdded: 'task.screen_added',
  /** A Workbench pass opened in Your folder; `data.batchId` names its batch. */
  PassOpened: 'pass.opened',
  /**
   * A pass moved on as a whole (closing, a close step, closed, settled, abandoning, abandoned) or a row
   * of its close changed (a sign-off wait, its stack, its pull request, a header notice); `data` names
   * what changed.
   */
  PassChanged: 'pass.changed',
  /** A turn of a pass task began; `data.turnId` names it. */
  PassTurnStarted: 'pass.turn_started',
  /** A turn of a pass task ended, ready, stopped or failed; `data.turnId` names it. */
  PassTurnEnded: 'pass.turn_ended',
  /** A pass task's page is Ready for the builder; `data.turnId` names the turn that made it so. */
  PassPageReady: 'pass.page_ready',
  /** A shared change of a pass was kept, replaced or dropped (`PassSharedChangedData`). */
  PassSharedChanged: 'pass.shared_changed',
  /** A pass task's page was signed off and landed (`PassPageSignedOffData`). */
  PassPageSignedOff: 'pass.page_signed_off',
  /** A pass closed (`PassClosedData`). */
  PassClosed: 'pass.closed',
  /** A closed pass settled: its work is in the base, or the folder moved on (`PassSettledData`). */
  PassSettled: 'pass.settled',
  /** A page's turn broke the pass's preview (`PassPreviewBrokenData`). */
  PassPreviewBroken: 'pass.preview_broken',
  /** A turn of the page that broke the preview loaded it cleanly (`PassPreviewMendedData`). */
  PassPreviewMended: 'pass.preview_mended',
  WorkstreamCreated: 'workstream.created',
  WorkstreamChanged: 'workstream.changed',
  /** A run changed an eval suite's definition file (`EvalDefinitionChangedData`). */
  EvalDefinitionChanged: 'eval.definition_changed',
  /** A watchpoint count that was being made landed; the entity is the project, and a page showing `counting` asks again. */
  WatchpointCoverageLanded: 'watchpoint.coverage_landed',
  /** A live eval run started or ended (`EvalLiveRunChangedData`). */
  EvalLiveRunChanged: 'eval.live_run_changed',
  /** What a queued run waits for changed (`data.wait`, a `QueueWait` or null); nothing was written to its row. */
  WorkstreamWaitChanged: 'workstream.wait_changed',
  SessionStarted: 'session.started',
  SessionActivity: 'session.activity',
  SessionContext: 'session.context',
  SessionEnded: 'session.ended',
  ClaimAcquired: 'claim.acquired',
  ClaimReleased: 'claim.released',
  InboxOpened: 'inbox.opened',
  InboxChanged: 'inbox.changed',
  HandoffRecorded: 'handoff.recorded',
  EvidenceRecorded: 'evidence.recorded',
  CommitRecorded: 'commit.recorded',
  DecisionRecorded: 'decision.recorded',
  DecisionWithdrawn: 'decision.withdrawn',
  PrincipleSaved: 'principle.saved',
  /** A session's bootstrap or re-injected context pack: what it used and what it dropped (spec §9). */
  ContextPacked: 'context.packed',
  DeviationRecorded: 'deviation.recorded',
  ProposalCreated: 'proposal.created',
  ProposalResolved: 'proposal.resolved',
  RecoveryStep: 'recovery.step',
  SettingsChanged: 'settings.changed',
  PersonaSaved: 'persona.saved',
  /** Nothing emits it now; event rows written while flows existed hold it, and the event log still parses them. */
  FlowSaved: 'flow.saved',
  PersonSaved: 'person.saved',
  PersonRemoved: 'person.removed',
  /** A stakeholder send changed state or content; `entityId` is the send. */
  StakeholderSendChanged: 'stakeholder_send.changed',
  LinearPostChanged: 'linear_post.changed',
  SlackConnectionChanged: 'slack.connection.changed',
  /** A device paired, was used or was revoked (`DeviceChangedData`); `entityType: 'device'`. */
  DeviceChanged: 'device.changed',
  /** Sharing this Mac changed state; `entityType: 'sharing'`, `entityId: 'this_mac'`, data `{ state: SharingState }`. */
  SharingChanged: 'sharing.changed',
  StakeholderTimersChanged: 'stakeholder_timers.changed',
  /** A question card was triaged (`InboxTriagedData`). */
  InboxTriaged: 'inbox.triaged',
  TeamSaved: 'team.saved',
  RoutingRulesSaved: 'routing_rules.saved',
  ModelProfileSaved: 'model_profile.saved',
  BenchmarksSynced: 'benchmarks.synced',
  ProjectChanged: 'project.changed',
  StepChanged: 'step.changed',
  BatchUpdated: 'batch.updated',
  BoardColumnSaved: 'board_column.saved',
  BoardColumnDeleted: 'board_column.deleted',
  NetworkHostsChanged: 'network_hosts.changed',
  /** One account's sign-in to one of the builder's MCP servers changed state (`McpSignInChangedData`); never a url. */
  McpSignInChanged: 'mcp_sign_in.changed',
  GoalCreated: 'goal.created',
  GoalChanged: 'goal.changed',
  ShapeChanged: 'shape.changed',
  /** A chat was created, renamed, moved in the strip, archived or touched; `entityType: 'chat'`. */
  ChatChanged: 'chat.changed',
  /** A conversation stored an item; `data` names its id, seq and kind. */
  ConversationItemAdded: 'conversation.item_added',
  /** A stored item changed in place (a plan, a marker resolved, a card's call); `data.id`. */
  ConversationItemUpdated: 'conversation.item_updated',
  /** An explore conversation moved to another §6.7 state; `data.state`. */
  ConversationState: 'conversation.state',
  /** A Plan's record gained or changed documents, entries, findings or proposals; `data.what` says which. */
  PlanRecordChanged: 'plan.record_changed',
  /** A task's cited anchors were checked against its workstream's base; `data.counts` per result. */
  PlanAnchorChecked: 'plan.anchor_checked',
  /** A workstream's gate holds its slot and starts (Shape spec §8: lane time counts from here). */
  GateStarted: 'gate.started',
  /**
   * A gate has ended, with its exit code and duration. A lane's gate (`entityType: 'workstream'`)
   * follows its `gate.started`; a batch's shipping gate (`entityType: 'batch'`) has no start event.
   * `data.projectId` and `data.command` let a later gate's timeout read how long a pass takes.
   */
  GateFinished: 'gate.finished',
  /** Who holds a project's checkout changed (`entityType: 'project'`, `entityId` the project). */
  FolderHoldChanged: 'folder_hold.changed',
  /** A notice that asks the builder nothing (`NoticePostedData`); filed under its task, else its project, else the app. */
  NoticePosted: 'notice.posted',
  /** The holds the status line shows changed (`StatusDto`); `entityType: 'app'`. */
  StatusChanged: 'status.changed',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/** Persisted before it is pushed; `seq` is monotonic, so a client replays from the last one it saw. */
export const DaemonEvent = z.object({
  seq: z.int().positive(),
  type: z.enum(EventType),
  entityType: z.string(),
  entityId: z.string(),
  data: z.record(z.string(), z.json()),
  at: z.iso.datetime(),
});
export type DaemonEvent = z.infer<typeof DaemonEvent>;
