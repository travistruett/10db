import type { ChildProcess } from 'node:child_process';

/** How long a daemon gets to shut down after SIGTERM before it is killed. */
export const DAEMON_STOP_TIMEOUT_MS = 30_000;

const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/** Resolves when the child has exited, at once if it already has, so a crashed child never hangs a wait. */
export function waitForExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
}

const stops = new WeakMap<ChildProcess, Promise<void>>();

/**
 * SIGTERM, then SIGKILL if the child is still running after `timeoutMs`. Every caller for the same child
 * shares one stop: a second SIGTERM would kill a daemon part-way through its clean shutdown.
 */
export function stopChild(
  child: ChildProcess,
  timeoutMs: number = DAEMON_STOP_TIMEOUT_MS,
): Promise<void> {
  const existing = stops.get(child);
  if (existing) return existing;
  const stop = terminate(child, timeoutMs);
  stops.set(child, stop);
  return stop;
}

async function terminate(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return;
  const exited = waitForExit(child);
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (!hasExited(child)) child.kill('SIGKILL');
  }, timeoutMs);
  await exited;
  clearTimeout(timer);
}

/** Each pid's parent, from `ps -axo pid=,ppid=` output. */
function parentPids(tree: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of tree.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || Number.isNaN(pid) || Number.isNaN(ppid))
      continue;
    parents.set(pid, ppid);
  }
  return parents;
}

/** Every pid below `rootPid`, from `ps -axo pid=,ppid=` output. */
export function descendantPids(tree: string, rootPid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parentPids(tree))
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const found = new Set<number>();
  const queue = [rootPid];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

const SERVER_COMMAND = /mantine\/mcp-server|\/\.bin\/mcp-server/;

/**
 * The env keys of the repo server processes that descend from `daemonPid`, from `ps -axww -E -o pid=,command=`
 * output, or null while none runs. Only the deepest process of each chain counts: srt's host and npm name the
 * server on their command lines too, and their env is not the server's. Another Claude Code window's copy of
 * the same server is not counted. Keys only: values are never kept.
 */
export function repoServerEnvKeys(input: {
  readonly tree: string;
  readonly envListing: string;
  readonly daemonPid: number;
}): string[] | null {
  const mine = descendantPids(input.tree, input.daemonPid);
  const parents = parentPids(input.tree);
  const servers = new Map<number, string[]>();
  for (const line of input.envListing.split('\n')) {
    const [pid, ...words] = line.trim().split(/\s+/);
    if (mine.has(Number(pid)) && SERVER_COMMAND.test(line)) servers.set(Number(pid), words);
  }
  const launchers = new Set<number>();
  for (const pid of servers.keys()) {
    for (let up = parents.get(pid); up !== undefined && mine.has(up); up = parents.get(up)) {
      launchers.add(up);
    }
  }
  const keys = new Set<string>();
  for (const [pid, words] of servers) {
    if (launchers.has(pid)) continue;
    for (const word of words) {
      const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word)?.[1];
      if (key) keys.add(key);
    }
  }
  return keys.size > 0 ? [...keys].sort() : null;
}
