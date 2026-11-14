import { createHash } from 'node:crypto';
import { SKIP_SUMMARY_MAX } from '@10db/contracts';

// T4: how a skip names a call, and the key a follow-up matches an approved call by. The summary is
// for a person and may be cut; the key is over the call's deciding fields, uncut, so two calls that
// share a prefix never match, and the same call in another worktree does.

/** The one field that says what each known tool does; everything else is a label or a limit. */
const DECIDING: Readonly<Record<string, string>> = {
  Bash: 'command',
  Monitor: 'command',
  WebFetch: 'url',
  WebSearch: 'query',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
  SandboxNetworkAccess: 'host',
};

/** A field that changes what a known tool does beside its deciding one. */
const ALSO_DECIDING = ['run_in_background'] as const;

const deciding = (toolName: string): string | undefined =>
  Object.hasOwn(DECIDING, toolName) ? DECIDING[toolName] : undefined;

function asJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** A call in a few words: its command, url, query, path or host; else the tool and its input. */
export function callSummary(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): { readonly text: string; readonly cut: boolean } {
  const field = deciding(toolName);
  const value = field === undefined ? undefined : input[field];
  const whole = typeof value === 'string' && value !== '' ? value : `${toolName} ${asJson(input)}`;
  return whole.length > SKIP_SUMMARY_MAX
    ? { text: `${whole.slice(0, SKIP_SUMMARY_MAX)}…`, cut: true }
    : { text: whole, cut: false };
}

/** JSON with every object's keys sorted, so the same call always reads the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}

/**
 * The hex SHA-256 of the tool, a NUL, and the canonical JSON of the call's deciding fields (the
 * whole input for a tool 10db doesn't know), with the checkout's path written as `<checkout>`.
 */
export function callKey(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  checkout: string,
): string {
  const field = deciding(toolName);
  const fields =
    field === undefined
      ? input
      : Object.fromEntries(
          [field, ...ALSO_DECIDING].flatMap((key) =>
            Object.hasOwn(input, key) ? [[key, input[key]]] : [],
          ),
        );
  const json = asJson(canonical(fields));
  const placed = checkout === '' ? json : json.split(checkout).join('<checkout>');
  return createHash('sha256').update(`${toolName}\0${placed}`).digest('hex');
}
