/** A handle's longest form, as the contract's key allows. */
const MAX_HANDLE = 40;

/** A handle proposed from a name: lowercase words joined by hyphens, starting with a letter. */
function proposeHandle(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (/^[a-z]/.test(slug) ? slug : `p-${slug}`).slice(0, MAX_HANDLE).replace(/-+$/, '');
}

/**
 * The handle 10db gives a new person: made from the name, never shown or typed. When someone has it
 * already, a number goes on the end ("mark-ellis-2"), so the daemon never refuses a clash.
 */
export function uniqueHandle(name: string, taken: ReadonlySet<string>): string {
  const base = proposeHandle(name);
  let handle = base;
  for (let n = 2; taken.has(handle); n += 1) {
    const suffix = `-${String(n)}`;
    handle = `${base.slice(0, MAX_HANDLE - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  return handle;
}
