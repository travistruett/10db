import { z } from 'zod';

export const EventType = {
  AccountSaved: 'account.saved',
  AccountCapReached: 'account.cap_reached',
  AccountPaused: 'account.paused',
  AccountResumed: 'account.resumed',
  /** An account's browser sign-in ended: it finished, failed, was cancelled or timed out. */
  AccountLoginEnded: 'account.login_ended',
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
  FlowSaved: 'flow.saved',
  PersonSaved: 'person.saved',
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
  GoalCreated: 'goal.created',
  GoalChanged: 'goal.changed',
  ShapeChanged: 'shape.changed',
  /** A workstream's gate holds its slot and starts (Shape spec §8: lane time counts from here). */
  GateStarted: 'gate.started',
  /** The gate that `gate.started` began has ended, with its exit code. */
  GateFinished: 'gate.finished',
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
