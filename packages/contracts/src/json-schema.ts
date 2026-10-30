import { z } from 'zod';
import {
  BatchDto,
  BatchStartInput,
  BatchStartResult,
  ProjectViewDto,
  TaskStartResult,
} from './batches';
import {
  AccountCreatedDto,
  AccountDto,
  AccountIdentityDto,
  AccountInput,
  AccountPatch,
  AccountSecretInput,
  AccountSignInDto,
  AccountUsageDto,
} from './accounts';
import { AaModelDto, BenchmarkStatusDto } from './benchmarks';
import { AdvertisedBuilderToolInputs, BuilderToolName } from './builder-mcp-tools';
import {
  BoardColumnDelete,
  BoardColumnDto,
  BoardColumnInput,
  BoardColumnPatch,
  TaskMove,
} from './board';
import {
  InboxItemDto,
  ProjectDto,
  ProjectPatch,
  TaskDto,
  TaskPatch,
  WorkstreamDto,
} from './entities';
import { DaemonEvent } from './events';
import { FlowDto, FlowInput, FlowPatch } from './flows';
import { FolderInspectInput, FolderInspection, FolderInspectResult } from './folders';
import { HandoffInput } from './handoff';
import { HealthResponse } from './health';
import { McpToolInputs, McpToolName, McpToolOutputs } from './mcp-tools';
import { ModelProfileDto, ModelProfilePatch } from './model-profiles';
import { PickerProposalDto } from './picker';
import { StepPlanDto } from './steps';
import { WorkstreamChangesDto } from './workstream-changes';
import {
  PersonaDto,
  PersonaInput,
  PersonaPatch,
  PersonDto,
  PersonInput,
  RoutingRuleDto,
  RoutingRulesInput,
  TeamDto,
  TeamInput,
} from './team';
import {
  EventsHead,
  KeepAwakeInput,
  KeepAwakeStatus,
  McpServerReview,
  McpServerStatusDto,
  SystemCheckDto,
} from './system';

const mcpSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.values(McpToolName).flatMap((tool): [string, z.ZodType][] => [
    [`mcp-${tool.replaceAll('_', '-')}-input`, McpToolInputs[tool]],
    [`mcp-${tool.replaceAll('_', '-')}-output`, McpToolOutputs[tool]],
  ]),
);

const builderMcpSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.values(BuilderToolName).map((tool): [string, z.ZodType] => [
    `builder-mcp-${tool.replaceAll('_', '-')}-input`,
    AdvertisedBuilderToolInputs[tool],
  ]),
);

/** Every schema visible outside the daemon, keyed by the file stem of its generated JSON Schema. */
export const CONTRACT_SCHEMAS: Record<string, z.ZodType> = {
  'health-response': HealthResponse,
  'account-created-dto': AccountCreatedDto,
  'account-dto': AccountDto,
  'account-identity-dto': AccountIdentityDto,
  'account-input': AccountInput,
  'account-patch': AccountPatch,
  'account-secret-input': AccountSecretInput,
  'account-sign-in-dto': AccountSignInDto,
  'account-usage-dto': AccountUsageDto,
  'daemon-event': DaemonEvent,
  'handoff-input': HandoffInput,
  'batch-dto': BatchDto,
  'batch-start-input': BatchStartInput,
  'batch-start-result': BatchStartResult,
  'project-view-dto': ProjectViewDto,
  'task-start-result': TaskStartResult,
  'project-dto': ProjectDto,
  'task-dto': TaskDto,
  'project-patch': ProjectPatch,
  'task-patch': TaskPatch,
  'workstream-dto': WorkstreamDto,
  'inbox-item-dto': InboxItemDto,
  'system-check-dto': SystemCheckDto,
  'keep-awake-status': KeepAwakeStatus,
  'events-head': EventsHead,
  'keep-awake-input': KeepAwakeInput,
  'mcp-server-review': McpServerReview,
  'mcp-server-status-dto': McpServerStatusDto,
  'aa-model-dto': AaModelDto,
  'benchmark-status-dto': BenchmarkStatusDto,
  'board-column-delete': BoardColumnDelete,
  'board-column-dto': BoardColumnDto,
  'board-column-input': BoardColumnInput,
  'board-column-patch': BoardColumnPatch,
  'task-move': TaskMove,
  'flow-dto': FlowDto,
  'flow-input': FlowInput,
  'flow-patch': FlowPatch,
  'folder-inspect-input': FolderInspectInput,
  'folder-inspection': FolderInspection,
  'folder-inspect-result': FolderInspectResult,
  'model-profile-dto': ModelProfileDto,
  'model-profile-patch': ModelProfilePatch,
  'picker-proposal-dto': PickerProposalDto,
  'person-dto': PersonDto,
  'person-input': PersonInput,
  'persona-dto': PersonaDto,
  'persona-input': PersonaInput,
  'persona-patch': PersonaPatch,
  'routing-rule-dto': RoutingRuleDto,
  'routing-rules-input': RoutingRulesInput,
  'step-plan-dto': StepPlanDto,
  'team-dto': TeamDto,
  'team-input': TeamInput,
  'workstream-changes-dto': WorkstreamChangesDto,
  ...mcpSchemas,
  ...builderMcpSchemas,
};

/** Renders each registered schema as JSON Schema text, keyed by file name. */
export function renderJsonSchemas(): Map<string, string> {
  return new Map(
    Object.entries(CONTRACT_SCHEMAS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stem, schema]) => [
        `${stem}.schema.json`,
        `${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }), null, 2)}\n`,
      ]),
  );
}
