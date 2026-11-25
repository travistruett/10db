/**
 * Whether a Bash call asks Claude Code to run it outside the sandbox (`dangerouslyDisableSandbox`).
 * Anything but an absent, null or false flag counts, so a spelling Claude Code reads as true is never
 * missed: a value it refuses fails the call before it runs, so asking about it costs nothing.
 */
export function runsOutsideSandbox(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const flag: unknown = Reflect.get(input, 'dangerouslyDisableSandbox');
  return flag !== undefined && flag !== null && flag !== false && flag !== 'false';
}
