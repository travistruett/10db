import { OUTBOUND_PATTERNS, SECRET_PATTERN_NAMES } from '../stakeholders';

// What a dev login printed, fit to show the builder: its last lines with every sign-in address, token
// and secret masked, since the command's own output holds the credential it signs a browser in with.

/** How many of the command's last lines are shown. */
const SHOWN_LINES = 12;

/** The longest line shown; a longer one is cut. */
const LINE_MAX = 300;

const MASK = '***';

const SECRET_PATTERNS: readonly RegExp[] = OUTBOUND_PATTERNS.filter((p) =>
  SECRET_PATTERN_NAMES.includes(p.name),
).map((p) => new RegExp(p.pattern.source, p.pattern.flags.replace('g', '') + 'g'));

/** An absolute address: scheme, host and everything after, which may carry a token. */
const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** A route's query string: it may be the token. */
const QUERY = /\?\S*/g;

/** A long run of token characters: a bare token or session id that no pattern names. */
const BARE_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g;

/** A line with every address, query and secret in it masked. */
function maskLine(line: string): string {
  let masked = line.replace(ADDRESS, '<address>').replace(QUERY, `?${MASK}`);
  masked = masked.replace(BARE_TOKEN, MASK);
  for (const pattern of SECRET_PATTERNS) masked = masked.replace(pattern, MASK);
  return masked.length > LINE_MAX ? `${masked.slice(0, LINE_MAX)}…` : masked;
}

/** The last lines of a dev login's output, masked; empty when it printed none. */
export function loginOutputTail(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-SHOWN_LINES)
    .map(maskLine)
    .join('\n');
}
