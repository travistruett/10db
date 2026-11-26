// A dev login signs the picture browser in as a fictional user, never as a real person. The one form
// of a person's identity the daemon can see in a command without reading the repository is an email
// address, so a command naming one outside the domains reserved for tests and examples (RFC 2606,
// RFC 6761) is refused before it runs.

/** Domains reserved for examples, whole. */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'] as const;
/** Top-level names reserved for tests and examples. */
const RESERVED_TOP_LEVELS = ['test', 'example', 'invalid', 'localhost'] as const;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

function reserved(domain: string): boolean {
  const name = domain.toLowerCase();
  if (RESERVED_DOMAINS.some((d) => name === d || name.endsWith(`.${d}`))) return true;
  const top = name.slice(name.lastIndexOf('.') + 1);
  return RESERVED_TOP_LEVELS.some((t) => t === top);
}

/** Why a dev login command may sign in as a real person: the first email it names off the reserved domains; null when it names none. */
export function realAccountProblem(command: string): string | null {
  for (const match of command.matchAll(EMAIL)) {
    const domain = match[1] ?? '';
    if (!reserved(domain))
      return `The command names ${match[0]}, which is not on a domain reserved for tests (such as example.test or example.com). A dev login signs in as a fictional user only.`;
  }
  return null;
}
