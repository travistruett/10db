import { z } from 'zod';

export const EventType = {
  ProjectCreated: 'project.created',
  TaskCreated: 'task.created',
  TaskChanged: 'task.changed',
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
  DeviationRecorded: 'deviation.recorded',
  ProposalCreated: 'proposal.created',
  ProposalResolved: 'proposal.resolved',
  ProviderPaused: 'provider.paused',
  ProviderResumed: 'provider.resumed',
  RecoveryStep: 'recovery.step',
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
