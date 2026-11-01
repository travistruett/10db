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
import {
  JudgeCallDto,
  JudgeConfigPatch,
  JudgeKeyInput,
  JudgeStatusDto,
  JudgeTestResultDto,
} from './judge';
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
import {
  AreaProposalInput,
  AreaProposalResult,
  FolderInspectInput,
  FolderInspection,
  FolderInspectResult,
} from './folders';
import {
  GoalAdoptError,
  GoalAdoptInput,
  GoalBrief,
  GoalCriterionDto,
  GoalDigestDto,
  GoalDto,
} from './goals';
import { HandoffInput } from './handoff';
import { HealthResponse } from './health';
import { McpToolInputs, McpToolName, McpToolOutputs } from './mcp-tools';
import { ModelProfileDto, ModelProfilePatch } from './model-profiles';
import { PickerProposalDto } from './picker';
import { RunNextResult } from './run-next';
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
  LanePermissionsDto,
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
  'lane-permissions-dto': LanePermissionsDto,
  'mcp-server-review': McpServerReview,
  'mcp-server-status-dto': McpServerStatusDto,
  'aa-model-dto': AaModelDto,
  'benchmark-status-dto': BenchmarkStatusDto,
  'judge-call-dto': JudgeCallDto,
  'judge-config-patch': JudgeConfigPatch,
  'judge-key-input': JudgeKeyInput,
  'judge-status-dto': JudgeStatusDto,
  'judge-test-result-dto': JudgeTestResultDto,
  'board-column-delete': BoardColumnDelete,
  'board-column-dto': BoardColumnDto,
  'board-column-input': BoardColumnInput,
  'board-column-patch': BoardColumnPatch,
  'task-move': TaskMove,
  'run-next-result': RunNextResult,
  'flow-dto': FlowDto,
  'flow-input': FlowInput,
  'flow-patch': FlowPatch,
  'folder-inspect-input': FolderInspectInput,
  'folder-inspection': FolderInspection,
  'folder-inspect-result': FolderInspectResult,
  'area-proposal-input': AreaProposalInput,
  'area-proposal-result': AreaProposalResult,
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
  'goal-adopt-error': GoalAdoptError,
  'goal-adopt-input': GoalAdoptInput,
  'goal-brief': GoalBrief,
  'goal-criterion-dto': GoalCriterionDto,
  'goal-digest-dto': GoalDigestDto,
  'goal-dto': GoalDto,
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
