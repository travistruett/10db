import { lstatSync, realpathSync } from 'node:fs';
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

/** The real path of `path`, or `path` when it can't be resolved. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
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
 */
function filesystemOf(sandbox: LaneSandboxSpec): Record<string, Access> {
  const { allowRead, allowWrite, denyRead, denyWrite } = sandbox.settings.filesystem;
  const entries = new Map<string, Access>();
  const grant = (path: string, access: Access): void => {
    const held = entries.get(path);
    if (held === undefined || STRICTNESS[access] > STRICTNESS[held]) entries.set(path, access);
  };
  const grants = [...allowRead, sandbox.checkout, ...allowWrite].filter((path) => !isPattern(path));
  for (const path of allowRead) {
    if (!isPattern(path) && !opensMoreThanItself(path, grants)) grant(path, 'read');
  }
  const writable = [sandbox.checkout, ...allowWrite];
  for (const path of writable) grant(path, 'write');
  for (const path of denyRead) if (path !== '/') grant(path, 'deny');
  for (const path of denyWrite) {
    const denied = denyRead.some((root) => root !== '/' && isEqualOrUnder(path, root));
    if (!writable.some((root) => isEqualOrUnder(path, root)) || denied) continue;
    entries.set(path, 'read');
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
