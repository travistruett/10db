import { GRANT_TARGET_MAX, type ProjectId, type TrustGrantDto } from '@10db/contracts';
import { listTrustGrants, type DbReader } from '@10db/db';
import { LIMITS } from './limits';

/** The longest call that is kept as it is; a longer one needs the builder's note to say what to allow. */
const QUOTED_CALL_MAX = 200;

/** Whitespace, control and format characters: none may end a grant's line or hide inside it. */
const SPACING = /[\s\p{Cc}\p{Cf}]+/gu;
/** Characters `JSON.stringify` leaves raw that still break or hide a line. */
const UNSAFE_IN_QUOTES = /[\u2028\u2029\p{Cf}]/gu;

const withoutDefaults = (text: string): string => text.replaceAll('$defaults', 'defaults');

/** Cut to `GRANT_TARGET_MAX` at the last space at or before it, or at it when there is none. */
function cut(text: string): string {
  if (text.length <= GRANT_TARGET_MAX) return text;
  const space = text.lastIndexOf(' ', GRANT_TARGET_MAX);
  return (space > 0 ? text.slice(0, space) : text.slice(0, GRANT_TARGET_MAX)).trim();
}

/**
 * What a grant allows: the builder's note on one line, or without one the call itself in quotes, so text an
 * agent wrote never reads as a rule. Null when there is no note and the call is too long to keep whole.
 */
export function grantTargetOf(note: string | null, summary: string): string | null {
  const said = note === null ? '' : withoutDefaults(note).replace(SPACING, ' ').trim();
  if (said !== '') return cut(said);
  if (summary.length > QUOTED_CALL_MAX) return null;
  const quoted = JSON.stringify(withoutDefaults(summary)).replace(
    UNSAFE_IN_QUOTES,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const target = `the call ${quoted}`;
  return target.length > GRANT_TARGET_MAX ? null : target;
}

/** A grant as the line every judge reads. */
export function grantLine(grant: Pick<TrustGrantDto, 'limit' | 'target'>): string {
  return grant.limit === null
    ? `Allowed by the builder in this project: ${grant.target}`
    : `Allowed by the builder in this project (${LIMITS[grant.limit].label}): ${grant.target}`;
}

/** The project's grants as lines, read fresh, so a removed grant stops at once. */
export function projectGrantLines(db: DbReader, projectId: ProjectId): string[] {
  return listTrustGrants(db, projectId).map(grantLine);
}
