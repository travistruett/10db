import {
  commandName,
  leadingWords,
  runsInBackground,
  splitCommand,
  stringField,
  stripCommandPrefixes,
} from '../guard';
import { startsBackgroundJob } from '../shape';
import type { ChatCall } from './confinement';

/** Programs whose job is to start something that outlives them, by the name the shell runs. */
const DETACHERS: ReadonlySet<string> = new Set([
  'nohup',
  'setsid',
  'disown',
  'tmux',
  'screen',
  'at',
  'batch',
  'daemon',
  'systemd-run',
  'launchctl',
  'open',
]);

/** Whether one command line may leave something running: a line the guard can't read counts as one. */
function detaches(command: string): boolean {
  if (startsBackgroundJob(command)) return true;
  try {
    return splitCommand(command).some((segment) => {
      if (segment.separator === '&' || !segment.wordsCertain) return true;
      const words = leadingWords(segment.words).command;
      const command = stripCommandPrefixes(words, {
        lookThroughRunners: true,
        skipRedirections: true,
      });
      // `nohup` is itself a prefix the guard looks through, so every word up to the command is read too.
      const prefixes = words.slice(0, words.length - command.length);
      return [...prefixes, command[0] ?? ''].some((word) => DETACHERS.has(commandName(word)));
    });
  } catch {
    return true;
  }
}

/**
 * Whether a command starts something that can go on after the call returns: Claude Code's own background
 * flag, or a job the shell or a detaching program leaves running (`&`, `nohup`, `env nohup`, `/usr/bin/nohup`,
 * `tmux`, `launchctl`…). The chat's turn can't watch either, so once one has started nothing that was allowed
 * to run outside the sandbox is remembered.
 */
export function startsBackground(call: Pick<ChatCall, 'toolName' | 'input'>): boolean {
  if (call.toolName !== 'Bash' || typeof call.input !== 'object' || call.input === null)
    return false;
  const flag: unknown = Reflect.get(call.input, 'run_in_background');
  const command = stringField(call.input, 'command');
  return runsInBackground({ run_in_background: flag }) || (command !== null && detaches(command));
}
