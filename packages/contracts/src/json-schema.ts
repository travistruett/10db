import { z } from 'zod';
import { InboxItemDto, ProjectDto, TaskDto, WorkstreamDto } from './entities';
import { DaemonEvent } from './events';
import { HandoffInput } from './handoff';
import { HealthResponse } from './health';
import { McpToolInputs, McpToolName, McpToolOutputs } from './mcp-tools';
import { McpServerReview, McpServerStatusDto, SystemCheckDto } from './system';

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
  'workstream-dto': WorkstreamDto,
  'inbox-item-dto': InboxItemDto,
  'system-check-dto': SystemCheckDto,
  'mcp-server-review': McpServerReview,
  'mcp-server-status-dto': McpServerStatusDto,
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
