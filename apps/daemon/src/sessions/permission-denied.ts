import { z } from 'zod';
import { limitOfDenial, type DeniedCall } from '../trust';
import type { HookCall, HookCalls } from './claude-session-hooks';

/**
 * Claude Code's report that a call was refused without a card. It names the tool and the call's id
 * but not the call's input, which the PreToolUse hook saw. The SDK's other fields are left alone.
 */
const PermissionDenied = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('permission_denied'),
  tool_name: z.string(),
  tool_use_id: z.string(),
  decision_reason_type: z.string().optional(),
  decision_reason: z.string().optional(),
  message: z.string().optional(),
});

/** The `decision_reason_type` of each denial 10db shows; a rule or mode denial is the builder's own. */
const DENIAL_BY = new Map<string, DeniedCall['by']>([
  ['classifier', 'classifier'],
  ['safetyCheck', 'safety_check'],
]);

/** A tool name is at most this long in a notice and a go-ahead. */
const MAX_TOOL_NAME_CHARS = 100;

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * The whole call, never cut: a command, a url, a query, an edit's file, else the tool and its input
 * as JSON. A go-ahead names exactly this, so it is the agent's request as it ran.
 */
export function summaryOfCall(call: HookCall): string {
  const { toolName } = call;
  // The hook's input is the model's own JSON: parsed here, where it is read.
  const parsed = z.record(z.string(), z.unknown()).safeParse(call.input);
  const input = parsed.success ? parsed.data : {};
  switch (toolName) {
    case 'Bash':
    case 'Monitor':
      return asText(input['command']) ?? asJson(call);
    case 'WebFetch':
      return asText(input['url']) ?? asJson(call);
    case 'WebSearch':
      return asText(input['query']) ?? asJson(call);
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return asText(input['file_path']) ?? asJson(call);
    default:
      return asJson(call);
  }
}

function asJson({ toolName, input }: HookCall): string {
  try {
    return `${toolName} ${JSON.stringify(input)}`;
  } catch {
    return toolName;
  }
}

/**
 * The call a `system/permission_denied` message reports, or null for a message that is not one, a
 * rule or mode denial (the builder's own settings), or a reason type 10db does not show. A call the
 * hook never saw is named by its tool alone.
 */
export function deniedCallOf(message: unknown, calls: HookCalls): DeniedCall | null {
  const parsed = PermissionDenied.safeParse(message);
  if (!parsed.success) return null;
  const denied = parsed.data;
  const by = DENIAL_BY.get(denied.decision_reason_type ?? '');
  if (by === undefined) return null;
  const taken = calls.take(denied.tool_use_id);
  // An id that names another tool's call is not this call.
  const seen = taken?.toolName === denied.tool_name ? taken : undefined;
  // The name goes into the builder's go-ahead as text, so nothing but a name's own characters does.
  const toolName = denied.tool_name.replace(/[^\w.:-]/gu, '_').slice(0, MAX_TOOL_NAME_CHARS);
  const reason = denied.decision_reason ?? denied.message ?? 'Claude Code gave no reason';
  return {
    toolUseId: denied.tool_use_id,
    toolName,
    summary: seen === undefined ? toolName : summaryOfCall({ ...seen, toolName }),
    reason,
    by,
    limit: limitOfDenial(reason),
  };
}
