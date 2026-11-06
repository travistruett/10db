import { isEqualOrUnder, type LaneSandboxSpec } from '../sandbox';

/** What a path may do, strictest last: Codex lets `deny` beat `write` and `write` beat `read`. */
type Access = 'read' | 'write' | 'deny';
const STRICTNESS: Readonly<Record<Access, number>> = { read: 0, write: 1, deny: 2 };

/** Codex's own base grant, which `denyRead: ['/']` becomes: what a command needs to start. */
const MINIMAL = ':minimal';

/** A pattern the profile holds for Claude Code's sandbox, such as a listing grant; Codex has no match. */
const isPattern = (path: string): boolean => path.includes('*') || path.includes('[');

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
  for (const path of allowRead) if (!isPattern(path)) grant(path, 'read');
  const writable = [sandbox.checkout, ...allowWrite];
  for (const path of writable) grant(path, 'write');
  for (const path of denyRead) if (path !== '/') grant(path, 'deny');
  for (const path of denyWrite) {
    if (!writable.some((root) => isEqualOrUnder(path, root)) || entries.get(path) === 'deny') {
      continue;
    }
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
