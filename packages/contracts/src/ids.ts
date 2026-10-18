import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

/** A lower-case RFC 9562 UUIDv7, which sorts by creation time as text. */
const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function idSchema<const B extends string>(prefix: string, brand: B) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${UUID_V7}$`), `expected a ${brand} (${prefix}_…)`)
    .brand<B>();
}

const ID_SCHEMAS = {
  Project: idSchema('prj', 'ProjectId'),
  Task: idSchema('tsk', 'TaskId'),
  Workstream: idSchema('ws', 'WorkstreamId'),
  Session: idSchema('ses', 'SessionId'),
  Handoff: idSchema('hof', 'HandoffId'),
  Claim: idSchema('clm', 'ClaimId'),
  InboxItem: idSchema('inb', 'InboxItemId'),
  ToolOp: idSchema('top', 'ToolOpId'),
  Evidence: idSchema('evd', 'EvidenceId'),
  Decision: idSchema('dec', 'DecisionId'),
  Deviation: idSchema('dvn', 'DeviationId'),
  Source: idSchema('src', 'SourceId'),
  Proposal: idSchema('prp', 'ProposalId'),
  PermissionRule: idSchema('prm', 'PermissionRuleId'),
  Persona: idSchema('per', 'PersonaId'),
  Flow: idSchema('flw', 'FlowId'),
  Person: idSchema('psn', 'PersonId'),
  RoutingRule: idSchema('rtr', 'RoutingRuleId'),
  ModelProfile: idSchema('mpf', 'ModelProfileId'),
} as const;

const ID_PREFIX = {
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
  Flow: 'flw',
  Person: 'psn',
  RoutingRule: 'rtr',
  ModelProfile: 'mpf',
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
export const FlowId = ID_SCHEMAS.Flow;
export type FlowId = IdOf<'Flow'>;
export const PersonId = ID_SCHEMAS.Person;
export type PersonId = IdOf<'Person'>;
export const RoutingRuleId = ID_SCHEMAS.RoutingRule;
export type RoutingRuleId = IdOf<'RoutingRule'>;
export const ModelProfileId = ID_SCHEMAS.ModelProfile;
export type ModelProfileId = IdOf<'ModelProfile'>;
