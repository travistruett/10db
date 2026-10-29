/** Flags whose next word is their value, so it is not mistaken for the subcommand. */
const VALUE_FLAGS = new Set([
  '--filter',
  '-F',
  '--dir',
  '-C',
  '--prefix',
  '--workspace',
  '--manifest-path',
  '-p',
  '--package',
  '--config',
]);

/** Runners whose remaining words are themselves a command (`pnpm exec drizzle-kit generate`). */
export const RUNNERS: readonly (readonly string[])[] = [
  ['npx'],
  ['pnpm', 'exec'],
  ['pnpm', 'dlx'],
  ['npm', 'exec'],
  ['yarn', 'dlx'],
];

/** A word that is neither a flag nor a flag value, with its index in the command. */
interface PlainWord {
  readonly word: string;
  readonly at: number;
}

/**
 * The words that are neither flags nor flag values, each with its index in `words`: in
 * `pnpm --filter x add zod` they are `pnpm`, `add` and `zod`, at 0, 3 and 4.
 */
export function plainWords(words: readonly string[]): PlainWord[] {
  const out: PlainWord[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? '';
    if (!w.startsWith('-')) out.push({ word: w, at: i });
    else if (VALUE_FLAGS.has(w)) i += 1;
  }
  return out;
}

/** The command's words without flags or flag values: `pnpm --filter x add zod` → `pnpm add zod`. */
function withoutFlags(words: readonly string[]): string[] {
  return plainWords(words).map((p) => p.word);
}

export function startsWithWords(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.every((p, i) => words[i] === p);
}

/**
 * Every way a command line can be read, each as one space-joined string: the line as written, the
 * line without flags, and, for a runner such as `npx` or `pnpm exec`, what it runs (with and
 * without that command's own flags).
 */
export function commandForms(words: readonly string[]): { bare: string[][]; lines: string[] } {
  const bare = withoutFlags(words);
  const runner = RUNNERS.find((r) => startsWithWords(bare, r));
  const bareForms = runner ? [bare, bare.slice(runner.length)] : [bare];
  const lines = [words.join(' '), ...bareForms.map((f) => f.join(' '))];
  if (runner) {
    // Raw words after the runner's own words, so `pnpm dlx vercel --prod` keeps `--prod`. Flags
    // (and the values of flags that take one) before or between the runner words are skipped.
    let consumed = 0;
    let i = 0;
    while (i < words.length) {
      const w = words[i] ?? '';
      if (w.startsWith('-')) i += VALUE_FLAGS.has(w) ? 2 : 1;
      else if (consumed < runner.length) {
        consumed += 1;
        i += 1;
      } else break;
    }
    lines.push(words.slice(i).join(' '));
  }
  return { bare: bareForms, lines };
}
