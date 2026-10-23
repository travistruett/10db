import { z } from 'zod';
import { AaModelDto, BenchmarkStatusDto } from './benchmarks';
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
import { HandoffInput } from './handoff';
import { HealthResponse } from './health';
import { McpToolInputs, McpToolName, McpToolOutputs } from './mcp-tools';
import { ModelProfileDto, ModelProfilePatch } from './model-profiles';
import { StepPlanDto } from './steps';
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

/** Every schema visible outside the daemon, keyed by the file stem of its generated JSON Schema. */
export const CONTRACT_SCHEMAS: Record<string, z.ZodType> = {
  'health-response': HealthResponse,
  'daemon-event': DaemonEvent,
  'handoff-input': HandoffInput,
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
  'model-profile-dto': ModelProfileDto,
  'model-profile-patch': ModelProfilePatch,
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
  ...mcpSchemas,
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
