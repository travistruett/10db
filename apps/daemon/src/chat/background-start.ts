import { runsInBackground, stringField } from '../guard';
import { startsBackgroundJob } from '../shape';
import type { ChatCall } from './confinement';

/**
 * Whether a command starts something that can go on after the call returns: Claude Code's own background
 * flag, or a job the shell detaches (`&`, `nohup`, `setsid`, `disown`). The chat's turn can't watch either,
 * so once one has started nothing that was allowed to run outside the sandbox is remembered.
 */
export function startsBackground(call: Pick<ChatCall, 'toolName' | 'input'>): boolean {
  if (call.toolName !== 'Bash' || typeof call.input !== 'object' || call.input === null)
    return false;
  const flag: unknown = Reflect.get(call.input, 'run_in_background');
  const command = stringField(call.input, 'command');
  return (
    runsInBackground({ run_in_background: flag }) ||
    (command !== null && startsBackgroundJob(command))
  );
}
