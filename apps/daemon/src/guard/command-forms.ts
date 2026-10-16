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
const RUNNERS: readonly (readonly string[])[] = [
  ['npx'],
  ['pnpm', 'exec'],
  ['pnpm', 'dlx'],
  ['npm', 'exec'],
  ['yarn', 'dlx'],
];

/** The command's words without flags or flag values: `pnpm --filter x add zod` → `pnpm add zod`. */
function withoutFlags(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? '';
    if (!w.startsWith('-')) out.push(w);
    else if (VALUE_FLAGS.has(w)) i += 1;
  }
  return out;
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
