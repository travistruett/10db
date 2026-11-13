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
 * The one input key a tool's summary shows, and the keys beside it that change nothing the call does
 * (a label, a timeout, what to read out of a fetched page). A tool not listed, an edit among them, is
 * always its whole input: an edit's go-ahead approves its content, as Claude Code's prompt shows it.
 */
const SHOWN: Readonly<
  Record<string, { readonly key: string; readonly labels: readonly string[] }>
> = {
  Bash: { key: 'command', labels: ['description', 'timeout'] },
  Monitor: { key: 'command', labels: ['description', 'timeout_ms'] },
  WebFetch: { key: 'url', labels: ['prompt'] },
  WebSearch: { key: 'query', labels: [] },
};

/**
 * The whole call, never cut: a command, a url or a query alone when nothing else in the input changes
 * what it does, else the tool and its whole input as JSON. A go-ahead names exactly this, so it is the
 * agent's request as it ran, and Allow this's length rule measures all of it.
 */
export function summaryOfCall(call: HookCall): string {
  // The hook's input is the model's own JSON: parsed here, where it is read.
  const parsed = z.record(z.string(), z.unknown()).safeParse(call.input);
  const input = parsed.success ? parsed.data : {};
  const shown = Object.hasOwn(SHOWN, call.toolName) ? SHOWN[call.toolName] : undefined;
  if (shown === undefined) return asJson(call);
  const text = asText(input[shown.key]);
  const others = Object.keys(input).filter(
    (key) => key !== shown.key && !shown.labels.includes(key),
  );
  return text !== null && others.length === 0 ? text : asJson(call);
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
