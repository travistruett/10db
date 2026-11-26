import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

/** A lower-case RFC 9562 UUIDv7, which sorts by creation time as text. */
const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/**
 * An ID's schema. The first prefix is the one minted; the others are prefixes the kind still reads, for
 * rows that kept the id they had under an older kind.
 */
function idSchema<const B extends string>(prefixes: readonly [string, ...string[]], brand: B) {
  const [minted] = prefixes;
  const prefix = prefixes.length === 1 ? minted : `(?:${prefixes.join('|')})`;
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${UUID_V7}$`), `expected a ${brand} (${minted}_…)`)
    .brand<B>();
}

const ID_SCHEMAS = {
  Account: idSchema(['acc'], 'AccountId'),
  Project: idSchema(['prj'], 'ProjectId'),
  Task: idSchema(['tsk'], 'TaskId'),
  Workstream: idSchema(['ws'], 'WorkstreamId'),
  Session: idSchema(['ses'], 'SessionId'),
  Handoff: idSchema(['hof'], 'HandoffId'),
  Claim: idSchema(['clm'], 'ClaimId'),
  InboxItem: idSchema(['inb'], 'InboxItemId'),
  ToolOp: idSchema(['top'], 'ToolOpId'),
  Evidence: idSchema(['evd'], 'EvidenceId'),
  Decision: idSchema(['dec'], 'DecisionId'),
  Deviation: idSchema(['dvn'], 'DeviationId'),
  Source: idSchema(['src'], 'SourceId'),
  Proposal: idSchema(['prp'], 'ProposalId'),
  PermissionRule: idSchema(['prm'], 'PermissionRuleId'),
  Persona: idSchema(['per'], 'PersonaId'),
  Person: idSchema(['psn'], 'PersonId'),
  RoutingRule: idSchema(['rtr'], 'RoutingRuleId'),
  PersonContact: idSchema(['pcn'], 'PersonContactId'),
  StakeholderSend: idSchema(['snd'], 'StakeholderSendId'),
  ModelProfile: idSchema(['mpf'], 'ModelProfileId'),
  Principle: idSchema(['pri'], 'PrincipleId'),
  Batch: idSchema(['bat'], 'BatchId'),
  BoardColumn: idSchema(['bcl'], 'BoardColumnId'),
  Goal: idSchema(['gol'], 'GoalId'),
  GoalCriterion: idSchema(['gcr'], 'GoalCriterionId'),
  JudgeCall: idSchema(['jdg'], 'JudgeCallId'),
  Shape: idSchema(['shp'], 'ShapeId'),
  ShapeProposal: idSchema(['spp'], 'ShapeProposalId'),
  ShapeAccept: idSchema(['sac'], 'ShapeAcceptId'),
  ShapeLink: idSchema(['slk'], 'ShapeLinkId'),
  ShapeFinding: idSchema(['shf'], 'ShapeFindingId'),
  ShapeQuestion: idSchema(['sqn'], 'ShapeQuestionId'),
  ShapeAttachment: idSchema(['sat'], 'ShapeAttachmentId'),
  ShapeAttachmentRevision: idSchema(['sar'], 'ShapeAttachmentRevisionId'),
  ShapeEntry: idSchema(['sen'], 'ShapeEntryId'),
  ShapeEntryVersion: idSchema(['sev'], 'ShapeEntryVersionId'),
  TaskContextCheck: idSchema(['tcx'], 'TaskContextCheckId'),
  LandingGroup: idSchema(['lgp'], 'LandingGroupId'),
  Kind: idSchema(['knd'], 'KindId'),
  Pass: idSchema(['pas'], 'PassId'),
  PassTurn: idSchema(['ptn'], 'PassTurnId'),
  TaskScreen: idSchema(['tsc'], 'TaskScreenId'),
  LinearPost: idSchema(['lnp'], 'LinearPostId'),
  DesignCheck: idSchema(['dck'], 'DesignCheckId'),
  PassPreviewMark: idSchema(['ppm'], 'PassPreviewMarkId'),
  TaskPageReport: idSchema(['tpr'], 'TaskPageReportId'),
  Conversation: idSchema(['cnv'], 'ConversationId'),
  ConversationItem: idSchema(['cvi', 'shm', 'tmg'], 'ConversationItemId'),
  ConversationFile: idSchema(['cvf', 'sfl', 'tfl'], 'ConversationFileId'),
  Chat: idSchema(['cht'], 'ChatId'),
  SkippedAction: idSchema(['skp'], 'SkippedActionId'),
  SkipListing: idSchema(['skl'], 'SkipListingId'),
  RunHost: idSchema(['rhs'], 'RunHostId'),
  TrustGrant: idSchema(['tgr'], 'TrustGrantId'),
  TrustPrecedent: idSchema(['tpd'], 'TrustPrecedentId'),
  Device: idSchema(['dev'], 'DeviceId'),
  PushSubscription: idSchema(['psh'], 'PushSubscriptionId'),
  EvalLiveRun: idSchema(['elr'], 'EvalLiveRunId'),
} as const;

const ID_PREFIX = {
  Account: 'acc',
  Project: 'prj',
  Task: 'tsk',
  Workstream: 'ws',
  Session: 'ses',
  Handoff: 'hof',
  Claim: 'clm',
  InboxItem: 'inb',
  ToolOp: 'top',
  Evidence: 'evd',
  Decision: 'dec',
  Deviation: 'dvn',
  Source: 'src',
  Proposal: 'prp',
  PermissionRule: 'prm',
  Persona: 'per',
  Person: 'psn',
  RoutingRule: 'rtr',
  PersonContact: 'pcn',
  StakeholderSend: 'snd',
  ModelProfile: 'mpf',
  Principle: 'pri',
  Batch: 'bat',
  BoardColumn: 'bcl',
  Goal: 'gol',
  GoalCriterion: 'gcr',
  JudgeCall: 'jdg',
  Shape: 'shp',
  ShapeProposal: 'spp',
  ShapeAccept: 'sac',
  ShapeLink: 'slk',
  ShapeFinding: 'shf',
  ShapeQuestion: 'sqn',
  ShapeAttachment: 'sat',
  ShapeAttachmentRevision: 'sar',
  ShapeEntry: 'sen',
  ShapeEntryVersion: 'sev',
  TaskContextCheck: 'tcx',
  LandingGroup: 'lgp',
  Kind: 'knd',
  Pass: 'pas',
  PassTurn: 'ptn',
  TaskScreen: 'tsc',
  LinearPost: 'lnp',
  DesignCheck: 'dck',
  PassPreviewMark: 'ppm',
  TaskPageReport: 'tpr',
  Conversation: 'cnv',
  ConversationItem: 'cvi',
  ConversationFile: 'cvf',
  Chat: 'cht',
  SkippedAction: 'skp',
  SkipListing: 'skl',
  RunHost: 'rhs',
  TrustGrant: 'tgr',
  TrustPrecedent: 'tpd',
  Device: 'dev',
  PushSubscription: 'psh',
  EvalLiveRun: 'elr',
} as const satisfies Record<keyof typeof ID_SCHEMAS, string>;

export type IdKind = keyof typeof ID_SCHEMAS;
export type IdOf<K extends IdKind> = z.infer<(typeof ID_SCHEMAS)[K]>;

/**
 * Mints a new ID. Outside of parsing, this is the only way to obtain one. Called without options,
 * `v7` keeps a per-process sequence, so IDs minted in the same millisecond still sort in order.
 */
export function mintId<K extends IdKind>(kind: K): IdOf<K> {
  // The schema for K parses a string it just built from K's prefix, so the cast is the boundary.
  return ID_SCHEMAS[kind].parse(`${ID_PREFIX[kind]}_${uuidv7()}`) as IdOf<K>;
}

/** The UUID after an ID's prefix: what a row carries as its own id to a system that takes a UUID. */
export function idUuid(id: IdOf<IdKind>): string {
  return id.slice(id.indexOf('_') + 1);
}

/** The ID of `kind` whose UUID is `uuid`, as `idUuid` gave it; null for text that is not one. */
export function idOfUuid<K extends IdKind>(kind: K, uuid: string): IdOf<K> | null {
  const parsed = ID_SCHEMAS[kind].safeParse(`${ID_PREFIX[kind]}_${uuid}`);
  // The schema for K has just accepted the text, so the cast is the boundary, as in `mintId`.
  return parsed.success ? (parsed.data as IdOf<K>) : null;
}

export const ProjectId = ID_SCHEMAS.Project;
export type ProjectId = IdOf<'Project'>;
export const TaskId = ID_SCHEMAS.Task;
export type TaskId = IdOf<'Task'>;
export const WorkstreamId = ID_SCHEMAS.Workstream;
export type WorkstreamId = IdOf<'Workstream'>;
export const SessionId = ID_SCHEMAS.Session;
export type SessionId = IdOf<'Session'>;
export const HandoffId = ID_SCHEMAS.Handoff;
export type HandoffId = IdOf<'Handoff'>;
export const ClaimId = ID_SCHEMAS.Claim;
export type ClaimId = IdOf<'Claim'>;
export const InboxItemId = ID_SCHEMAS.InboxItem;
export type InboxItemId = IdOf<'InboxItem'>;
export const ToolOpId = ID_SCHEMAS.ToolOp;
export type ToolOpId = IdOf<'ToolOp'>;
export const EvidenceId = ID_SCHEMAS.Evidence;
export type EvidenceId = IdOf<'Evidence'>;
export const DecisionId = ID_SCHEMAS.Decision;
export type DecisionId = IdOf<'Decision'>;
export const DeviationId = ID_SCHEMAS.Deviation;
export type DeviationId = IdOf<'Deviation'>;
export const SourceId = ID_SCHEMAS.Source;
export type SourceId = IdOf<'Source'>;
export const ProposalId = ID_SCHEMAS.Proposal;
export type ProposalId = IdOf<'Proposal'>;
export const PermissionRuleId = ID_SCHEMAS.PermissionRule;
export type PermissionRuleId = IdOf<'PermissionRule'>;
export const PersonaId = ID_SCHEMAS.Persona;
export type PersonaId = IdOf<'Persona'>;
export const PersonId = ID_SCHEMAS.Person;
export type PersonId = IdOf<'Person'>;
export const RoutingRuleId = ID_SCHEMAS.RoutingRule;
export type RoutingRuleId = IdOf<'RoutingRule'>;
export const PersonContactId = ID_SCHEMAS.PersonContact;
export type PersonContactId = IdOf<'PersonContact'>;
export const StakeholderSendId = ID_SCHEMAS.StakeholderSend;
export type StakeholderSendId = IdOf<'StakeholderSend'>;
export const ModelProfileId = ID_SCHEMAS.ModelProfile;
export type ModelProfileId = IdOf<'ModelProfile'>;
export const PrincipleId = ID_SCHEMAS.Principle;
export type PrincipleId = IdOf<'Principle'>;
export const BatchId = ID_SCHEMAS.Batch;
export type BatchId = IdOf<'Batch'>;
export const BoardColumnId = ID_SCHEMAS.BoardColumn;
export type BoardColumnId = IdOf<'BoardColumn'>;
export const GoalId = ID_SCHEMAS.Goal;
export type GoalId = IdOf<'Goal'>;
export const GoalCriterionId = ID_SCHEMAS.GoalCriterion;
export type GoalCriterionId = IdOf<'GoalCriterion'>;
export const JudgeCallId = ID_SCHEMAS.JudgeCall;
export type JudgeCallId = IdOf<'JudgeCall'>;
export const ShapeId = ID_SCHEMAS.Shape;
export type ShapeId = IdOf<'Shape'>;
export const ShapeProposalId = ID_SCHEMAS.ShapeProposal;
export type ShapeProposalId = IdOf<'ShapeProposal'>;
export const ShapeAcceptId = ID_SCHEMAS.ShapeAccept;
export type ShapeAcceptId = IdOf<'ShapeAccept'>;
export const ShapeLinkId = ID_SCHEMAS.ShapeLink;
export type ShapeLinkId = IdOf<'ShapeLink'>;
export const ShapeFindingId = ID_SCHEMAS.ShapeFinding;
export type ShapeFindingId = IdOf<'ShapeFinding'>;
export const ShapeQuestionId = ID_SCHEMAS.ShapeQuestion;
export type ShapeQuestionId = IdOf<'ShapeQuestion'>;
export const ShapeAttachmentId = ID_SCHEMAS.ShapeAttachment;
export type ShapeAttachmentId = IdOf<'ShapeAttachment'>;
export const ShapeAttachmentRevisionId = ID_SCHEMAS.ShapeAttachmentRevision;
export type ShapeAttachmentRevisionId = IdOf<'ShapeAttachmentRevision'>;
export const ShapeEntryId = ID_SCHEMAS.ShapeEntry;
export type ShapeEntryId = IdOf<'ShapeEntry'>;
export const ShapeEntryVersionId = ID_SCHEMAS.ShapeEntryVersion;
export type ShapeEntryVersionId = IdOf<'ShapeEntryVersion'>;
export const TaskContextCheckId = ID_SCHEMAS.TaskContextCheck;
export type TaskContextCheckId = IdOf<'TaskContextCheck'>;
export const LandingGroupId = ID_SCHEMAS.LandingGroup;
export type LandingGroupId = IdOf<'LandingGroup'>;
export const KindId = ID_SCHEMAS.Kind;
export type KindId = IdOf<'Kind'>;
export const PassId = ID_SCHEMAS.Pass;
export type PassId = IdOf<'Pass'>;
export const PassTurnId = ID_SCHEMAS.PassTurn;
export type PassTurnId = IdOf<'PassTurn'>;
export const TaskScreenId = ID_SCHEMAS.TaskScreen;
export type TaskScreenId = IdOf<'TaskScreen'>;
export const LinearPostId = ID_SCHEMAS.LinearPost;
export type LinearPostId = IdOf<'LinearPost'>;
export const DesignCheckId = ID_SCHEMAS.DesignCheck;
export type DesignCheckId = IdOf<'DesignCheck'>;
export const PassPreviewMarkId = ID_SCHEMAS.PassPreviewMark;
export type PassPreviewMarkId = IdOf<'PassPreviewMark'>;
export const TaskPageReportId = ID_SCHEMAS.TaskPageReport;
export type TaskPageReportId = IdOf<'TaskPageReport'>;
export const ConversationId = ID_SCHEMAS.Conversation;
export type ConversationId = IdOf<'Conversation'>;
export const ConversationItemId = ID_SCHEMAS.ConversationItem;
export type ConversationItemId = IdOf<'ConversationItem'>;
export const ConversationFileId = ID_SCHEMAS.ConversationFile;
export type ConversationFileId = IdOf<'ConversationFile'>;
export const ChatId = ID_SCHEMAS.Chat;
export type ChatId = IdOf<'Chat'>;
export const SkippedActionId = ID_SCHEMAS.SkippedAction;
export type SkippedActionId = IdOf<'SkippedAction'>;
export const SkipListingId = ID_SCHEMAS.SkipListing;
export type SkipListingId = IdOf<'SkipListing'>;
export const RunHostId = ID_SCHEMAS.RunHost;
export type RunHostId = IdOf<'RunHost'>;
export const TrustGrantId = ID_SCHEMAS.TrustGrant;
export type TrustGrantId = IdOf<'TrustGrant'>;
export const TrustPrecedentId = ID_SCHEMAS.TrustPrecedent;
export type TrustPrecedentId = IdOf<'TrustPrecedent'>;
export const DeviceId = ID_SCHEMAS.Device;
export type DeviceId = IdOf<'Device'>;
export const PushSubscriptionId = ID_SCHEMAS.PushSubscription;
export type PushSubscriptionId = IdOf<'PushSubscription'>;
export const EvalLiveRunId = ID_SCHEMAS.EvalLiveRun;
export type EvalLiveRunId = IdOf<'EvalLiveRun'>;
/** A task's thread message is a conversation item. @alias */
export const TaskMessageId = ConversationItemId;
export type TaskMessageId = ConversationItemId;
/** A picture pasted into a task's thread is a conversation file. @alias */
export const TaskFileId = ConversationFileId;
export type TaskFileId = ConversationFileId;
export const AccountId = ID_SCHEMAS.Account;
export type AccountId = IdOf<'Account'>;
