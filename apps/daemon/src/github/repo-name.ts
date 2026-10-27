/** A GitHub repository as `owner/name`, from the forms of origin URL the daemon pins. */
const PART = /^[A-Za-z0-9._-]+$/;

/**
 * The `owner/name` of a github.com repository a pinned remote URL names, or null when it names
 * anything else. The daemon tells gh which repository with `-R`, so gh never reads a checkout's remotes.
 */
export function githubRepoOf(url: string): string | null {
  let path: string | null = null;
  const scp = /^(?:[A-Za-z0-9._-]+@)?github\.com:(.+)$/i.exec(url);
  if (scp?.[1]) path = scp[1];
  else if (/^(https|ssh):\/\//i.test(url)) {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() === 'github.com') path = parsed.pathname.replace(/^\//, '');
  }
  if (path === null) return null;
  const [owner, name, ...rest] = path
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .split('/');
  return rest.length === 0 && owner && name && PART.test(owner) && PART.test(name)
    ? `${owner}/${name}`
    : null;
}
