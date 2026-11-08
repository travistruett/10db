import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isEqualOrUnder, type LaneSandboxSpec } from '../sandbox';

/**
 * What a path may do. On one path the map keeps deny over write over read; across paths Codex
 * applies the most specific entry.
 */
type Access = 'read' | 'write' | 'deny';
const STRICTNESS: Readonly<Record<Access, number>> = { read: 0, write: 1, deny: 2 };

/** Codex's own base grant, which `denyRead: ['/']` becomes: what a command needs to start. */
const MINIMAL = ':minimal';

/** A pattern the profile holds for Claude Code's sandbox, such as a listing grant; Codex has no match. */
const isPattern = (path: string): boolean => path.includes('*') || path.includes('[');

/**
 * The real path of `path`. A path that doesn't exist yet is the real path of the nearest dir that does,
 * with the rest appended, so it still sits under the entries its dirs resolve to.
 */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realOrSelf(parent), basename(path));
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * True for a link whose real path no other read entry grants. Claude's sandbox opens only the link
 * (`/tmp`, `/var`, `/etc`), where Codex follows it and grants the whole target tree.
 */
function opensMoreThanItself(path: string, grants: readonly string[]): boolean {
  if (!isLink(path)) return false;
  const real = realOrSelf(path);
  // Another link grants nothing here: it would open the same tree.
  return !grants.some(
    (other) => other !== path && !isLink(other) && isEqualOrUnder(real, realOrSelf(other)),
  );
}

/**
 * The lane profile's file system as Codex's `permissions.lane.filesystem`. Two entries on one path
 * keep the stricter. A `denyWrite` under a writable path narrows it to `read`; anywhere else it gets
 * no entry, so the path stays closed under `:minimal`, where a `read` entry would open it.
 *
 * Entries are keyed by real path, so a link and its target are one entry. Codex's sandbox matches real
 * paths anyway, and it repeats every read and deny entry in the rules for its temp dirs: a list with
 * each alias of each toolchain install outgrows macOS's sandbox compiler, and then no command runs.
 * Every comparison between entries is made on real paths too, so a link can't carry a grant into a
 * denied tree. A `denyWrite` that is a link also keeps an entry on its own path, which sits under the
 * writable root and would otherwise stay writable, so a lane could swap the link: `read` when the lane
 * may already read its target, else `deny`.
 */
function filesystemOf(sandbox: LaneSandboxSpec): Record<string, Access> {
  const { allowRead, allowWrite, denyRead, denyWrite } = sandbox.settings.filesystem;
  const entries = new Map<string, Access>();
  const put = (key: string, access: Access): void => {
    const held = entries.get(key);
    if (held === undefined || STRICTNESS[access] > STRICTNESS[held]) entries.set(key, access);
  };
  const grant = (path: string, access: Access): void => {
    put(realOrSelf(path), access);
  };
  const denyRoots = denyRead.filter((root) => root !== '/');
  const realDenyRoots = denyRoots.map(realOrSelf);
  const grants = [...allowRead, sandbox.checkout, ...allowWrite].filter((path) => !isPattern(path));
  for (const path of allowRead) {
    if (isPattern(path) || opensMoreThanItself(path, grants)) continue;
    // A link whose target is in a denied tree the link itself is not in would reopen that tree.
    const real = realOrSelf(path);
    const intoDenied = realDenyRoots.some((root) => isEqualOrUnder(real, root));
    if (intoDenied && !denyRoots.some((root) => isEqualOrUnder(path, root))) continue;
    grant(path, 'read');
  }
  const writable = [sandbox.checkout, ...allowWrite];
  const realWritable = writable.map(realOrSelf);
  for (const path of writable) grant(path, 'write');
  for (const path of denyRead) if (path !== '/') grant(path, 'deny');
  /** Narrows a writable path to read: never a path outside the writable roots, and never a deny. */
  const narrow = (key: string, roots: readonly string[], denied: readonly string[]): void => {
    if (!roots.some((root) => isEqualOrUnder(key, root))) return;
    if (denied.some((root) => isEqualOrUnder(key, root)) || entries.get(key) === 'deny') return;
    entries.set(key, 'read');
  };
  /** Whether an entry already lets the lane read `real`, by real path. */
  const readable = (real: string): boolean =>
    [...entries].some(([key, access]) => access !== 'deny' && isEqualOrUnder(real, key));
  for (const path of denyWrite) {
    const real = realOrSelf(path);
    // Codex follows a link entry, so a link's own entry is what its target gets: a read of a denied
    // or unread target would open it, so such a link is denied instead.
    const link = isLink(path) && writable.some((root) => isEqualOrUnder(path, root));
    if (link && (realDenyRoots.some((root) => isEqualOrUnder(real, root)) || !readable(real)))
      put(path, 'deny');
    else narrow(path, writable, denyRoots);
    narrow(real, realWritable, realDenyRoots);
  }
  return { [MINIMAL]: 'read', ...Object.fromEntries(entries) };
}

/**
 * The lane profile as Codex's `permissions.lane`. An empty host list still sends `enabled: true`,
 * which blocks every host without cutting DNS, as `enabled: false` would. The profile's Mach lookups
 * have no Codex match and are left out.
 */
export function lanePermissions(sandbox: LaneSandboxSpec): Record<string, unknown> {
  const { network } = sandbox.settings;
  return {
    lane: {
      filesystem: filesystemOf(sandbox),
      network: {
        enabled: true,
        mode: 'full',
        domains: Object.fromEntries(network.allowedDomains.map((host) => [host, 'allow'])),
        allow_local_binding: network.allowLocalBinding === true,
        unix_sockets: Object.fromEntries(network.allowUnixSockets.map((path) => [path, 'allow'])),
      },
    },
  };
}
