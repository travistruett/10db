import { GRANT_TARGET_MAX, type ProjectId, type TrustGrantDto } from '@10db/contracts';
import { listTrustGrants, type DbReader } from '@10db/db';
import { LIMITS } from './limits';

/** The longest call that is kept as it is; a longer one needs the builder's note to say what to allow. */
const QUOTED_CALL_MAX = 200;

/** Whitespace, control and format characters: none may end a grant's line or hide inside it. */
const SPACING = /[\s\p{Cc}\p{Cf}]+/gu;
/** Characters `JSON.stringify` leaves raw that still break or hide a line. */
const UNSAFE_IN_QUOTES = /[\u2028\u2029\p{Cf}]/gu;
/** What a tool name may hold to be written into a grant: the names the agents give their tools. */
const TOOL_NAME = '[\\w.:-]{1,100}';

const withoutDefaults = (text: string): string => text.replaceAll('$defaults', 'defaults');

/** Cut to `GRANT_TARGET_MAX` at the last space at or before it, or at it when there is none. */
function cut(text: string): string {
  if (text.length <= GRANT_TARGET_MAX) return text;
  const space = text.lastIndexOf(' ', GRANT_TARGET_MAX);
  return (space > 0 ? text.slice(0, space) : text.slice(0, GRANT_TARGET_MAX)).trim();
}

/** A character as the `\u` escapes of each UTF-16 unit, so one outside the BMP stays a whole pair. */
const escaped = (char: string): string =>
  Array.from(
    { length: char.length },
    (_, at) => `\\u${char.charCodeAt(at).toString(16).padStart(4, '0')}`,
  ).join('');

/**
 * What a grant allows: the builder's note on one line, or without one the call itself in quotes, named by its
 * tool, so text an agent wrote never reads as a rule and a call of one tool never stands for another's. Null
 * when there is no note and the call can't be kept as written: too long, or holding `$defaults`, which the
 * auto mode prose reads as a word of its own and which is never rewritten in a call.
 */
export function grantTargetOf(
  note: string | null,
  summary: string,
  toolName: string,
): string | null {
  const said = note === null ? '' : withoutDefaults(note).replace(SPACING, ' ').trim();
  if (said !== '') return cut(said);
  if (summary.length > QUOTED_CALL_MAX || summary.includes('$defaults')) return null;
  if (!new RegExp(`^${TOOL_NAME}$`).test(toolName)) return null;
  const quoted = JSON.stringify(summary).replace(UNSAFE_IN_QUOTES, escaped);
  const target = `the ${toolName} call ${quoted}`;
  return target.length > GRANT_TARGET_MAX ? null : target;
}

const QUOTED_CALL = new RegExp(`^the (${TOOL_NAME}) call (".*")$`, 's');
/** A quoted call stored before grants named their tool: it says nothing of the tool, so it matches no call. */
const UNNAMED_QUOTED_CALL = /^the call ".*"$/s;

/** A quoted call of a grant with no note: the tool it was granted for and the call as its card showed it. */
export interface GrantedCall {
  readonly tool: string;
  readonly call: string;
}

/**
 * The call a grant with no note names; null for a grant in the builder's own words. The call is the agent's
 * text, so it is matched as written and never read by a judge as a rule.
 */
export function grantedCallOf(target: string): GrantedCall | null {
  const match = QUOTED_CALL.exec(target);
  const tool = match?.[1];
  const quoted = match?.[2];
  if (tool === undefined || quoted === undefined) return null;
  try {
    // The quotes are the JSON `grantTargetOf` wrote; anything else is not a quoted call.
    const call: unknown = JSON.parse(quoted);
    return typeof call === 'string' ? { tool, call } : null;
  } catch {
    return null;
  }
}

/** The Bash fields that only label a command; any other field changes what the call may do. */
const BASH_LABELS: ReadonlySet<string> = new Set(['command', 'description', 'timeout']);

/**
 * How a call is named for a grant, by the card that makes the grant, the hook judge and the broker alike: a Bash
 * command as written, else the input as JSON. A Bash call that carries a field beyond its command and labels
 * (the sandbox switched off, a wider host list) is named by its whole input, so a grant of the bare command
 * never covers it.
 */
export function grantCallSummary(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): string {
  const command = input['command'];
  if (
    toolName === 'Bash' &&
    typeof command === 'string' &&
    Object.keys(input).every((key) => BASH_LABELS.has(key))
  )
    return command;
  return JSON.stringify(input).slice(0, 2000);
}

const grantKey = (tool: string, call: string): string => JSON.stringify([tool, call]);

/** Whether the project's quoted-call grants (`projectGrantedCalls`) name this very call of this very tool. */
export function isGrantedCall(
  granted: ReadonlySet<string>,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): boolean {
  return granted.has(grantKey(toolName, grantCallSummary(toolName, input)));
}

/** A grant as the line every judge reads. */
export function grantLine(grant: Pick<TrustGrantDto, 'limit' | 'target'>): string {
  return grant.limit === null
    ? `Allowed by the builder in this project: ${grant.target}`
    : `Allowed by the builder in this project (${LIMITS[grant.limit].label}): ${grant.target}`;
}

/**
 * The project's grants in the builder's own words, as lines, read fresh, so a removed grant stops at once. A
 * grant of a quoted call is matched by `projectGrantedCalls` instead.
 */
export function projectGrantLines(db: DbReader, projectId: ProjectId): string[] {
  return listTrustGrants(db, projectId)
    .filter(
      (grant) => grantedCallOf(grant.target) === null && !UNNAMED_QUOTED_CALL.test(grant.target),
    )
    .map(grantLine);
}

/** The calls the project's grants with no note allow, each by its tool and exactly as written, read fresh. */
export function projectGrantedCalls(db: DbReader, projectId: ProjectId): ReadonlySet<string> {
  const calls = new Set<string>();
  for (const grant of listTrustGrants(db, projectId)) {
    const granted = grantedCallOf(grant.target);
    if (granted !== null) calls.add(grantKey(granted.tool, granted.call));
  }
  return calls;
}
