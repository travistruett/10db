import type { HazardDef } from '@10db/contracts';
import { redirectionViews, shellScripts, SHELLS, withoutRedirections } from './judge';
import { leadingWords, parseShell } from './shell-words';
import { executableTails, FEEDERS, takesDataArguments } from './wrapped-commands';

/** A character that makes the shell replace a word with text 10db cannot read from the command. */
const EXPANDING = /[$`*?[]/;
const EXPANDING_ALL = /[$`*?[]/g;
/** A program name written out in plain text. */
const PLAIN_PROGRAM = /^(?:~?[A-Za-z0-9_@+%,:./-]+|\[\[?)$/;

const MAX_DEPTH = 3;

const baseName = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

/** The fail-closed checks on one reading of a segment's words. */
function readingAsk(
  words: readonly string[],
  hazardPrograms: ReadonlySet<string>,
  tail: boolean,
): string | null {
  const program = programOf(words);
  const line = words.slice(words.indexOf(program));
  if (!tail && program !== '' && !PLAIN_PROGRAM.test(program)) {
    return `The program "${program}" is not written out, so 10db cannot tell what it runs.`;
  }
  // A hazard program anywhere in the command line (behind env, command, nice...) with a word the
  // shell expands after it: the expansion could select a hazard form.
  const at = line.findIndex((word) => hazardPrograms.has(baseName(word)));
  if (
    at >= 0 &&
    !takesDataArguments(program) &&
    line.slice(at + 1).some((word) => EXPANDING.test(word))
  ) {
    return 'A program with hazard forms is followed by a word the shell expands.';
  }
  // A feeder anywhere before the hazard program, however many wrappers stand between them.
  const feeder = line.findIndex((word) => FEEDERS.has(baseName(word)));
  if (feeder >= 0 && line.slice(feeder + 1).some((word) => hazardPrograms.has(baseName(word)))) {
    return `"${baseName(line[feeder] ?? '')}" feeds a program with hazard forms its arguments.`;
  }
  return null;
}

/** The program a segment runs: its first word that is not an assignment. */
function programOf(words: readonly string[]): string {
  return words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? '';
}

/**
 * A fail-closed reading of one command: a program that is not plain text, a hazard program followed
 * by a word the shell expands, or a wrapper that runs a hazard program, each of which could spell a
 * hazard 10db cannot see. Everything else is left to `hazardHit`.
 */
export function unreadableHazard(
  command: string,
  hazardPrograms: ReadonlySet<string>,
  depth = 0,
): string | null {
  const segments = parseShell(command).segments;
  for (const [index, segment] of segments.entries()) {
    const command = leadingWords(segment.words).command;
    const offset = segment.words.length - command.length;
    // A quoted literal such as '@10db/*' is text; only a word the shell fills in keeps its markers.
    const written = command.map((word, i) =>
      segment.dynamicWords[offset + i] === true
        ? EXPANDING.test(word) || word.startsWith('~')
          ? word
          : `${word}$`
        : word.replaceAll(EXPANDING_ALL, '_'),
    );
    // The parser keeps no mark of a quoted word, so every reading of the redirections is checked.
    for (const view of redirectionViews(written)) {
      const found = readingAsk(view, hazardPrograms, false);
      if (found !== null) return found;
      for (const tail of executableTails(view)) {
        const wrapped = readingAsk(tail, hazardPrograms, true);
        if (wrapped !== null) return wrapped;
      }
    }
    const words = withoutRedirections(written);
    const [head = ''] = words;
    // eval runs its words as shell text: read them again as a command, from the words as written.
    const evalAt = command.findIndex((word) => baseName(word) === 'eval');
    if (evalAt >= 0 && depth < MAX_DEPTH) {
      const body = command.slice(evalAt + 1).join(' ');
      const found = body === '' ? null : unreadableHazard(body, hazardPrograms, depth + 1);
      if (found !== null) return found;
    }
    const program = programOf(words);
    if (head === '') continue;
    // A segment the parser is unsure of, around a program with hazard forms, cannot be read.
    if (
      (!segment.wordsCertain || !segment.bracesCertain) &&
      words.some((word) => hazardPrograms.has(baseName(word)))
    ) {
      return 'The parser is unsure where this command around a hazard program begins and ends.';
    }
    if (SHELLS.has(baseName(program)) && segments[index - 1]?.separator === '|') {
      return `"${program}" reads the script piped into it, which 10db cannot read.`;
    }
    if (depth < MAX_DEPTH) {
      const documents = SHELLS.has(baseName(program)) ? segment.hereDocuments : [];
      const inner = [
        ...segment.nested,
        ...documents,
        ...shellScripts(withoutRedirections(command)),
      ];
      for (const body of inner) {
        const found = unreadableHazard(body, hazardPrograms, depth + 1);
        if (found !== null) return found;
      }
    }
  }
  return null;
}

/** The programs the hazards' commands start with (`pnpm`, `drizzle-kit`), by base name. */
export function hazardPrograms(hazards: readonly HazardDef[]): Set<string> {
  return new Set(
    hazards.flatMap((hazard) => hazard.commands.map((c) => baseName(c.split(' ')[0] ?? ''))),
  );
}
