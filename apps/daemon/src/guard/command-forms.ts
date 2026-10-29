import { commandName } from './shell-words';

/**
 * Flags whose next word is their value, for a program without a flag table below, so the value is
 * not mistaken for the subcommand.
 */
const GENERIC_VALUE_FLAGS: ReadonlySet<string> = new Set([
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

/**
 * What a program does with its flags: the ones that take the next word as their value, and the ones
 * that do not. A flag in neither list may or may not take it, so both readings are tried.
 */
interface FlagTable {
  readonly values: ReadonlySet<string>;
  readonly booleans: ReadonlySet<string>;
}

const table = (values: string, booleans: string): FlagTable => ({
  values: new Set(values.split(' ')),
  booleans: new Set(booleans.split(' ')),
});

/** The programs with hazard forms, by name; any other program uses `GENERIC_VALUE_FLAGS`. */
const FLAG_TABLES: ReadonlyMap<string, FlagTable> = new Map([
  [
    'pnpm',
    table(
      '--filter -F --filter-prod --dir -C --reporter --loglevel --registry --store-dir --virtual-store-dir --lockfile-dir --modules-dir --package-import-method --node-linker --use-node-version --network-concurrency --child-concurrency --workspace-concurrency --fetch-timeout --fetch-retries --changed-files-ignore-pattern --test-pattern --resume-from --depth --cache-dir --state-dir --global-dir --global-bin-dir --hoist-pattern --public-hoist-pattern --tag --otp --access --publish-branch',
      '-r --recursive -s --silent -w --workspace-root --if-present --stream --parallel --no-bail --bail --aggregate-output --report-summary --reverse --sort --no-sort --color --no-color --offline --prefer-offline --frozen-lockfile --no-frozen-lockfile --force --ignore-scripts --prod -P --production --dev -D --global -g --save-dev --save-prod --save-optional -O --save-exact -E --workspace --ignore-workspace --no-optional --help -h --version -v --fix-lockfile --lockfile-only --shamefully-hoist --strict-peer-dependencies --use-stderr --verbose --latest -L --interactive -i --fail-if-no-match --include-workspace-root --no-lockfile',
    ),
  ],
  [
    'npm',
    table(
      '--prefix --workspace -w --registry --cache --userconfig --globalconfig --loglevel --tag --otp --scope --access --omit --include --install-strategy --location --before --package --call -c --script-shell --logs-dir --logs-max',
      '-g --global --save -S --save-dev -D --save-exact -E --no-save --silent -s --verbose -d -dd -ddd -q --quiet --force -f --legacy-peer-deps --no-audit --no-fund --audit --fund --ignore-scripts --dry-run --json --long -l --workspaces -ws --include-workspace-root --yes -y --no --offline --prefer-offline --production --global-style --package-lock-only --no-package-lock --help -h --version -v -L',
    ),
  ],
  [
    'yarn',
    table(
      '--cwd --registry --cache-folder --modules-folder --network-timeout --network-concurrency --mutex --proxy --https-proxy --otp --tag --access --use-yarnrc --link-folder --global-folder --preferred-cache-folder',
      '--silent -s --verbose --json --offline --prefer-offline --frozen-lockfile --immutable --check-files --force --production --dev -D --exact -E --tilde -T --peer -P --optional -O --ignore-scripts --non-interactive --no-progress --no-lockfile --pure-lockfile -W --ignore-workspace-root-check --recursive -R --help -h --version -v --top-level --flat --all',
    ),
  ],
  [
    'cargo',
    table(
      '--manifest-path -p --package --exclude --features -F --target --target-dir --profile --color --config -Z -j --jobs --bin --example --test --bench --message-format --registry --rev --branch --tag --git --path --rename --lockfile-path --index --token --artifact-dir --name --vers',
      '-q --quiet -v --verbose -vv --offline --locked --frozen --release -r --all-targets --workspace --all --lib --bins --examples --tests --benches --doc --dry-run --dev -D --build -B --optional --no-default-features --all-features --no-run --no-fail-fast --help -h -V --ignore-rust-version --keep-going --no-deps --check --document-private-items --open --timings --allow-dirty --allow-staged',
    ),
  ],
  [
    'git',
    table(
      '-C -c --git-dir --work-tree --namespace --super-prefix --config-env --attr-source',
      '--no-pager -p --paginate -P --bare --no-replace-objects --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-optional-locks --no-lazy-fetch --help --version --exec-path --html-path --man-path --info-path',
    ),
  ],
]);

/** The most readings of one command tried; past it, an unknown flag is read as taking no value. */
const MAX_READINGS = 64;

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

/** The program the plain words so far belong to, after any runner (`pnpm exec drizzle-kit` is drizzle-kit). */
function programOf(plain: readonly PlainWord[]): string | null {
  let at = 0;
  for (;;) {
    const first = plain[at];
    if (first === undefined) return null;
    const name = commandName(first.word);
    const runner = RUNNERS.find(
      (r) => r[0] === name && r.every((word, i) => i === 0 || plain[at + i]?.word === word),
    );
    if (runner === undefined) return name;
    at += runner.length;
  }
}

/**
 * Every way the words can be read as plain words and flags with their values. A flag the program's
 * table lists reads one way; one it does not list, followed by a word, reads both with the word
 * taken as its value and without. In `npm --silent install x` the plain words are `npm`, `install`
 * and `x`; in `npm -p install x` they are those, or `npm` and `x`. The first reading takes every
 * unknown flag as having no value. A program with no table reads one way.
 */
export function plainWordReadings(words: readonly string[]): PlainWord[][] {
  const readings: PlainWord[][] = [];
  const walk = (from: number, plain: PlainWord[]): void => {
    for (let i = from; i < words.length; i += 1) {
      const w = words[i] ?? '';
      if (!w.startsWith('-')) {
        // A rustup toolchain, `cargo +stable add`, is no subcommand.
        const toolchain = w.startsWith('+') && plain.length === 1 && programOf(plain) === 'cargo';
        if (!toolchain) plain.push({ word: w, at: i });
        continue;
      }
      const program = programOf(plain);
      const flags = program === null ? undefined : FLAG_TABLES.get(program);
      if (flags === undefined) {
        if (GENERIC_VALUE_FLAGS.has(w)) i += 1;
      } else if (flags.values.has(w)) {
        i += 1;
      } else if (w !== '--' && !flags.booleans.has(w) && !w.includes('=') && i + 1 < words.length) {
        const next = words[i + 1] ?? '';
        if (!next.startsWith('-') && readings.length < MAX_READINGS) {
          // The word is this flag's value: read the rest that way too.
          walk(i + 2, [...plain]);
        }
      }
    }
    readings.push(plain);
  };
  walk(0, []);
  // The reading with no unknown flag taking a value comes first.
  return readings.reverse();
}

/**
 * The words that are neither flags nor flag values, each with its index in `words`: in
 * `pnpm --filter x add zod` they are `pnpm`, `add` and `zod`, at 0, 3 and 4. An unknown flag takes
 * no value in this reading.
 */
export function plainWords(words: readonly string[]): PlainWord[] {
  return plainWordReadings(words)[0] ?? [];
}

export function startsWithWords(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.every((p, i) => words[i] === p);
}

/**
 * Every way a command line can be read, each as one space-joined string: the line as written, the
 * line without flags (in every reading of its unknown flags), and, for a runner such as `npx` or
 * `pnpm exec`, what it runs (with and without that command's own flags).
 */
export function commandForms(words: readonly string[]): { bare: string[][]; lines: string[] } {
  const bare: string[][] = [];
  const lines = [words.join(' ')];
  for (const reading of plainWordReadings(words)) {
    const plain = reading.map((p) => p.word);
    bare.push(plain);
    lines.push(plain.join(' '));
    const runner = RUNNERS.find((r) => startsWithWords(plain, r));
    if (runner) {
      bare.push(plain.slice(runner.length));
      lines.push(plain.slice(runner.length).join(' '));
      // Raw words from the program the runner runs, so `pnpm dlx vercel --prod` keeps `--prod`.
      const program = reading[runner.length];
      lines.push(words.slice(program?.at ?? words.length).join(' '));
    }
  }
  return { bare, lines };
}
