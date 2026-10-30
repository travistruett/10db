/**
 * CPU priority of the work 10db starts (`decisions/2026-10-30-lane-and-gate-priority.md`). A process
 * keeps its priority through fork and exec, so wrapping the one process 10db starts covers every
 * command it runs and everything those start, with no window in which a child runs at normal
 * priority. There is no switch: every lane and gate in every project gets it.
 *
 * Builder's apps (normal) > gates (`gate`) > lane sessions and their commands (`lane`).
 */
type PriorityTier = 'lane' | 'gate';

interface Launch {
  readonly file: string;
  readonly args: readonly string[];
}

/** macOS: `taskpolicy -b` is background QoS and I/O throttling; `-c utility` caps the QoS at utility. */
const TASKPOLICY = '/usr/sbin/taskpolicy';
const NICE = '/usr/bin/nice';

/** Both exec the program, so its pid is the child's pid and the caller's process group holds. */
export function atPriority(
  tier: PriorityTier,
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Launch {
  if (platform === 'darwin')
    return {
      file: TASKPOLICY,
      args: tier === 'lane' ? ['-b', file, ...args] : ['-c', 'utility', file, ...args],
    };
  return { file: NICE, args: ['-n', tier === 'lane' ? '19' : '10', file, ...args] };
}
