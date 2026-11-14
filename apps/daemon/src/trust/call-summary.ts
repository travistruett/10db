import { createHash } from 'node:crypto';
import { SKIP_SUMMARY_MAX } from '@10db/contracts';

// T4: how a skip names a call, and the key a follow-up matches an approved call by. The summary is
// for a person and may be cut; the key is over the whole call but its labels, uncut, so two calls
// that share a prefix never match, and the same call in another worktree does.

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

/**
 * The fields of each tool that label a call and change nothing it does. Every other field is part of
 * its key: a flag such as `dangerouslyDisableSandbox`, or an edit's content.
 */
const LABELS: Readonly<Record<string, readonly string[]>> = {
  Bash: ['description', 'timeout'],
  Monitor: ['description', 'timeout', 'timeout_ms'],
};

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

/** Stands in for the checkout in a key: a raw NUL, which JSON text never holds, so nothing collides. */
const CHECKOUT_MARK = '\u0000checkout\u0000';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The hex SHA-256 of the tool, a NUL, and the canonical JSON of the call's input without its label
 * fields, with the checkout's path marked where it is a whole path: followed by a separator (a slash,
 * a space, a shell operator), a quote or the end, so `/repo` inside `/repo-other` stays as it is.
 */
export function callKey(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  checkout: string,
): string {
  const labels = Object.hasOwn(LABELS, toolName) ? (LABELS[toolName] ?? []) : [];
  const fields = Object.fromEntries(Object.entries(input).filter(([key]) => !labels.includes(key)));
  const json = asJson(canonical(fields));
  const placed =
    checkout === ''
      ? json
      : json.replace(
          new RegExp(`${escapeRegExp(checkout)}(?=[/\\s"'\\\\;&|)]|$)`, 'g'),
          CHECKOUT_MARK,
        );
  return createHash('sha256').update(`${toolName}\0${placed}`).digest('hex');
}
