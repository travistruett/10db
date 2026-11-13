import { GITHUB_LOGIN_MESSAGE_MAX, isSignInUrl } from '@10db/contracts';

// CSI sequences (colours, cursor moves, erase) are all gh prints.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

const CODE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/i;
const URL = /(https:\/\/[^\s]+)/;

/**
 * The one-time code and the device page from gh's output lines, in either order and from either
 * stream: null until both have been printed. A page that is not the device page is not accepted.
 */
export function parseDeviceLogin(
  lines: readonly string[],
): { readonly code: string; readonly url: string } | null {
  let code: string | null = null;
  let url: string | null = null;
  for (const raw of lines) {
    const line = stripAnsi(raw).trim();
    const codeMatch = CODE.exec(line);
    if (codeMatch?.[1] !== undefined) code ??= codeMatch[1].toUpperCase();
    const urlMatch = URL.exec(line);
    if (urlMatch?.[1] !== undefined && isSignInUrl(urlMatch[1])) url ??= urlMatch[1];
  }
  return code !== null && url !== null ? { code, url } : null;
}

const KNOWN: readonly { readonly when: RegExp; readonly message: string }[] = [
  { when: /expired/i, message: 'The code expired. Press Sign In to get a new one.' },
  { when: /access_denied|access denied/i, message: 'GitHub refused the sign-in.' },
  {
    when: /error connecting to|dial (tcp|udp)|no such host|i\/o timeout|network is unreachable/i,
    message: "10db couldn't reach GitHub.",
  },
];

/**
 * A message safe to show for a gh that stopped without signing in: a known one where gh's wording is
 * known, otherwise gh's last line without colour codes, never more than the contract's bound.
 */
export function loginFailureMessage(lines: readonly string[]): string {
  const clean = lines.map((line) => stripAnsi(line).trim()).filter((line) => line !== '');
  const joined = clean.join('\n');
  const known = KNOWN.find((entry) => entry.when.test(joined));
  if (known) return known.message;
  const last = clean.at(-1);
  if (last === undefined) return 'gh stopped before the sign-in finished.';
  return last.slice(0, GITHUB_LOGIN_MESSAGE_MAX);
}
