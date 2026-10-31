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

/**
 * macOS: `taskpolicy -c utility` caps the QoS at utility, below the builder's apps; a lane is also niced, so
 * it yields to a gate. Not `taskpolicy -b`: background QoS throttles disk and network too, and slowed a
 * lane's Claude Code start past the daemon's wait for its account
 * (`decisions/2026-10-30-lanes-at-utility-priority.md`).
 */
const TASKPOLICY = '/usr/sbin/taskpolicy';
const NICE = '/usr/bin/nice';

/** Both exec the program, so its pid is the child's pid and the caller's process group holds. */
export function atPriority(
  tier: PriorityTier,
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Launch {
  if (platform === 'darwin') {
    const clamped = ['-c', 'utility', file, ...args];
    return tier === 'lane'
      ? { file: NICE, args: ['-n', '10', TASKPOLICY, ...clamped] }
      : { file: TASKPOLICY, args: clamped };
  }
  return { file: NICE, args: ['-n', tier === 'lane' ? '19' : '10', file, ...args] };
}
