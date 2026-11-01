import type { HazardDef } from '@10db/contracts';
import { commandForms, startsWithWords } from './command-forms';
import { SHELLS, commandOf, shellQuote, shellScripts, redirectionReadings } from './judge';
import { findExecCommands, parseShell } from './shell-words';

/** The deepest `sh -c`, `eval` and `find -exec` nesting the guard follows. */
const MAX_DEPTH = 3;

export interface HazardHit {
  /** The hazard's name. */
  readonly name: string;
  /** The words of the command that ran it, past wrappers and its path. */
  readonly words: readonly string[];
}

/**
 * The first hazard a shell command runs, in a substitution, a here-document, an `sh -c` script, an
 * `eval` or a `find -exec` too. It walks what the guard's shell judge walks and compares each
 * command the way the judge does, so the two agree on what needs a hazard claim.
 */
export function hazardHit(
  command: string,
  hazards: readonly HazardDef[],
  depth = 0,
): HazardHit | null {
  for (const segment of parseShell(command).segments) {
    const { words } = commandOf(segment);
    const head = words[0] ?? '';
    const inner = [...segment.nested, ...segment.hereDocuments].map((body) => ({ body, depth }));
    if (depth < MAX_DEPTH) {
      const deeper = depth + 1;
      if (SHELLS.has(head)) {
        inner.push(...shellScripts(words).map((body) => ({ body, depth: deeper })));
      }
      if (head === 'find') {
        const execs = findExecCommands(words).map((exec) => exec.map(shellQuote).join(' '));
        inner.push(...execs.map((body) => ({ body, depth: deeper })));
      }
      if (head === 'eval') inner.push({ body: words.slice(1).join(' '), depth: deeper });
    }
    for (const next of inner) {
      const found = hazardHit(next.body, hazards, next.depth);
      if (found !== null) return found;
    }
    const readings = redirectionReadings(words).map((reading) => commandForms(reading));
    for (const hazard of hazards) {
      if (
        hazard.commands.some((c) =>
          readings.some((forms) => forms.bare.some((f) => startsWithWords(f, c.split(' ')))),
        )
      ) {
        return { name: hazard.name, words };
      }
    }
  }
  return null;
}

/** The name of the first hazard the command runs, or null when it runs none. */
export function hazardFor(command: string, hazards: readonly HazardDef[]): string | null {
  return hazardHit(command, hazards)?.name ?? null;
}
