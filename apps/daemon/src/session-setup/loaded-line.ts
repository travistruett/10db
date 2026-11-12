import { Provider } from '@10db/contracts';
import type { SetupInput } from '../sandbox';
import type { LeftOut } from './left-out';

interface Loaded {
  /** The agent the session runs: Codex takes a plugin's skills and nothing else of it. */
  readonly provider: Provider;
  /** The builder's skills the sandbox kept, by name. */
  readonly skills: readonly string[];
  /** The plugins the sandbox kept, by id (`name@marketplace`). */
  readonly plugins: readonly string[];
  readonly projectFiles: SetupInput['projectFiles'];
  readonly leftOut: readonly LeftOut[];
}

/** `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  const last = names.at(-1) ?? '';
  return names.length < 2 ? last : `${names.slice(0, -1).join(', ')} and ${last}`;
}

/** A plugin's name as its skills are prefixed with it: the id before its marketplace. */
function pluginName(id: string): string {
  const at = id.lastIndexOf('@');
  return at > 0 ? id.slice(0, at) : id;
}

/**
 * The briefing's one line on what a session's setup brought and what it left out, which the note at
 * the end of the prompt explains; null when there is neither.
 */
export function loadedLine(loaded: Loaded): string | null {
  const projectSkills = new Set(
    loaded.projectFiles.flatMap((file) => {
      const [top, name] = file.relative.split('/');
      return top === 'skills' && name !== undefined ? [name] : [];
    }),
  ).size;
  const plugins = loaded.plugins.map(pluginName);
  const parts = [
    ...(loaded.skills.length > 0 ? [`${String(loaded.skills.length)} of your skills`] : []),
    ...(plugins.length > 0
      ? [
          `${loaded.provider === Provider.Codex ? 'the skills of ' : ''}the plugin${plugins.length > 1 ? 's' : ''} ${listed(plugins)}`,
        ]
      : []),
    ...(projectSkills > 0 ? [`${String(projectSkills)} project skills`] : []),
  ];
  if (parts.length === 0 && loaded.leftOut.length === 0) return null;
  const line = `Loaded for you: ${parts.length === 0 ? 'nothing' : parts.join(', ')}.`;
  if (loaded.leftOut.length === 0) return line;
  return `${line} Left out: ${loaded.leftOut.map((item) => item.what).join(', ')}, see the note at the end.`;
}
