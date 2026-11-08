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

/** How pnpm treats a flag, by its table: takes the next word, takes none, or is not listed. */
export function pnpmFlagKind(flag: string): 'value' | 'boolean' | 'unknown' {
  const flags = FLAG_TABLES.get('pnpm');
  if (flags?.values.has(flag)) return 'value';
  if (flags?.booleans.has(flag)) return 'boolean';
  return 'unknown';
}

/** The most readings of one command tried; past it, an unknown flag is read as taking no value. */
const MAX_READINGS = 64;

/** A runner: the words that name it, then the operands it takes before the command it runs. */
export interface Runner {
  readonly words: readonly string[];
  /** Plain words after `words` that name where the command runs, such as a service or container. */
  readonly operands: number;
  /** Runs the command in a container, so the command it runs may be a runner too. */
  readonly container?: true;
}

const runner = (words: string, operands = 0, container?: true): Runner => ({
  words: words.split(' '),
  operands,
  ...(container ? { container } : {}),
});

/**
 * Runners whose remaining words are themselves a command (`pnpm exec drizzle-kit generate`,
 * `docker compose exec -T backend uv lock`, `uv run python manage.py migrate`). A runner's own
 * flags are dropped with the other flags, so `-T` and `--rm` do not show.
 */
export const RUNNERS: readonly Runner[] = [
  runner('npx'),
  runner('pnpm exec'),
  runner('pnpm dlx'),
  runner('npm exec'),
  runner('yarn dlx'),
  runner('uv run'),
  runner('poetry run'),
  runner('bundle exec'),
  runner('docker compose exec', 1, true),
  runner('docker compose run', 1, true),
  runner('docker-compose exec', 1, true),
  runner('docker-compose run', 1, true),
  runner('docker container exec', 1, true),
  runner('docker exec', 1, true),
];

/** How many plain words a runner takes in all: its own and its operands. */
const runnerLength = (r: Runner): number => r.words.length + r.operands;

/** A word that is neither a flag nor a flag value, with its index in the command. */
interface PlainWord {
  readonly word: string;
  readonly at: number;
}

/** The runner the plain words start with, at `from`, if any. */
function runnerAt(plain: readonly PlainWord[], from: number): Runner | undefined {
  const first = plain[from];
  if (first === undefined) return undefined;
  const name = commandName(first.word);
  return RUNNERS.find(
    (r) =>
      r.words[0] === name && r.words.every((word, i) => i === 0 || plain[from + i]?.word === word),
  );
}

/** The program the plain words so far belong to, after any runner (`pnpm exec drizzle-kit` is drizzle-kit). */
function programOf(plain: readonly PlainWord[]): string | null {
  let at = 0;
  for (;;) {
    const first = plain[at];
    if (first === undefined) return null;
    const found = runnerAt(plain, at);
    if (found === undefined) return commandName(first.word);
    at += runnerLength(found);
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

export function startsWithWords(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.every((p, i) => words[i] === p);
}

/** The most readings of one package manager line followed; past it the line is refused as unread. */
const VARIANT_LIMIT = 4000;
const HELP_FLAGS: ReadonlySet<string> = new Set(['--version', '-v', '--help', '-h']);
const RUN_ALIASES: ReadonlySet<string> = new Set(['run', 'run-script', 'rum', 'urn']);

/** npm's subcommand spellings, by the canonical name a hazard lists. */
const NPM_SPELLINGS: Readonly<Record<string, readonly string[]>> = {
  install: [
    'i',
    'in',
    'ins',
    'inst',
    'insta',
    'instal',
    'isnt',
    'isnta',
    'isntal',
    'isntall',
    'add',
  ],
  ci: ['clean-install', 'ic', 'install-clean', 'isntall-clean'],
  'install-test': ['it', 'cit', 'install-ci-test'],
  uninstall: ['un', 'uni', 'unlink', 'remove', 'rm', 'r'],
  update: ['up', 'upgrade', 'udpate'],
};
const NPM_ALIASES: ReadonlyMap<string, string> = new Map(
  Object.entries(NPM_SPELLINGS).flatMap(([canonical, spellings]) =>
    spellings.map((spelling): [string, string] => [spelling, canonical]),
  ),
);
const BUN_ALIASES: Readonly<Record<string, string>> = { a: 'add', rm: 'remove', i: 'install' };

/** The ways one reading of a package manager's plain words is read otherwise, one rewrite apart. */
function rewrites(plain: readonly string[], words: readonly string[]): string[][] {
  const [manager, subcommand, ...rest] = plain;
  const out: string[][] = [];
  if (manager !== 'pnpm' && manager !== 'npm' && manager !== 'yarn' && manager !== 'bun')
    return out;
  if (subcommand !== undefined && RUN_ALIASES.has(subcommand)) out.push([manager, ...rest]);
  if ((manager === 'pnpm' || manager === 'yarn') && subcommand !== undefined) {
    out.push(plain.slice(1));
  }
  if (manager === 'yarn' && subcommand === 'workspace') out.push(['yarn', ...plain.slice(3)]);
  if (manager === 'yarn' && plain.length === 1 && !words.some((w) => HELP_FLAGS.has(w))) {
    out.push(['yarn', 'install']);
  }
  const canonical =
    subcommand === undefined
      ? undefined
      : manager === 'npm'
        ? NPM_ALIASES.get(subcommand)
        : manager === 'bun'
          ? BUN_ALIASES[subcommand]
          : undefined;
  if (canonical !== undefined) out.push([manager, canonical, ...rest]);
  return out;
}

/**
 * How a package manager reads the plain words other than as written, applying the rewrites until
 * none gives a new reading: `run` and its aliases name a script as the subcommand does (`pnpm run
 * db:migrate` is `pnpm db:migrate`), pnpm and yarn run a package binary given as the subcommand
 * (`pnpm drizzle-kit generate`), `yarn workspace <name>` runs the subcommand after it
 * (`yarn workspace a run s` is `yarn s`), a bare `yarn` installs, and npm's and bun's short and
 * misspelled subcommands read as the canonical one (`npm r x` is `npm uninstall x`).
 */
function packageManagerVariants(plain: readonly string[], words: readonly string[]): string[][] {
  const seen = new Map<string, string[]>();
  const queue = [[...plain]];
  while (queue.length > 0) {
    // Every rewrite drops words or settles on a canonical name, so the readings are a few per
    // suffix of the words; a count past this is a command nothing can read, not one to pass.
    if (seen.size > VARIANT_LIMIT) {
      throw new RangeError('A package manager command line has too many readings to follow.');
    }
    const next = queue.pop();
    if (next === undefined) break;
    for (const variant of rewrites(next, words)) {
      const key = variant.join('\u0000');
      if (key === plain.join('\u0000') || seen.has(key)) continue;
      seen.set(key, variant);
      queue.push(variant);
    }
  }
  return [...seen.values()];
}

/**
 * Every way a command line can be read: the line as written, the line without flags (in every
 * reading of its unknown flags), and, for a runner such as `npx` or `pnpm exec`, what it runs (with
 * and without that command's own flags), each as one space-joined string in `lines`. `bare` holds
 * the flagless readings a hazard command is compared with, less those that only preview (`uv lock
 * --check`, see `PREVIEWS`).
 */
export function commandForms(words: readonly string[]): { bare: string[][]; lines: string[] } {
  const bare: string[][] = [];
  const lines = [words.join(' ')];
  const add = (reading: readonly PlainWord[]): void => {
    const plain = reading.map((p) => p.word);
    if (!previews(reading, words)) bare.push(plain, ...packageManagerVariants(plain, words));
    lines.push(plain.join(' '));
  };
  for (const reading of plainWordReadings(words)) {
    add(reading);
    // What each runner in a chain runs: `docker compose exec backend uv run python x` is a runner
    // that runs a runner that runs `python x`.
    for (let from = 0; ;) {
      const found = runnerAt(reading, from);
      if (found === undefined) break;
      from += runnerLength(found);
      add(reading.slice(from));
      // Raw words from the program the runner runs, so `pnpm dlx vercel --prod` keeps `--prod`.
      lines.push(words.slice(reading[from]?.at ?? words.length).join(' '));
    }
  }
  return { bare, lines };
}

/**
 * Where the command a runner chain runs starts, by index in the words, once in each plain reading:
 * `docker compose exec -T backend sh -c x` runs `sh` at 5. Empty when no runner starts the words.
 */
export function runCommandStarts(words: readonly string[]): number[] {
  const starts = new Set<number>();
  for (const reading of plainWordReadings(words)) {
    let from = 0;
    for (
      let found = runnerAt(reading, from);
      found !== undefined;
      found = runnerAt(reading, from)
    ) {
      from += runnerLength(found);
    }
    if (from > 0) starts.add(reading[from]?.at ?? words.length);
  }
  return [...starts];
}

/** A hazard command that only reports what it would do when given one of its preview flags. */
interface Preview {
  readonly words: readonly string[];
  readonly flags: ReadonlySet<string>;
}

const preview = (words: string, flags: string): Preview => ({
  words: words.split(' '),
  flags: new Set(flags.split(' ')),
});

const DJANGO = ['manage.py', 'python manage.py', 'python3 manage.py', 'django-admin'];

/**
 * The hazard commands whose program reads a flag as a preview that writes nothing. Each is listed
 * with the program that takes it: a package manager's script (`pnpm db:migrate --check`) gets the
 * flag as an argument, npm reads an unknown flag as a setting and installs anyway, and Django's
 * `makemigrations --check` writes the migrations before 4.2, so none of those counts. A flag a
 * program's older release does not know makes it refuse the line.
 */
const PREVIEWS: readonly Preview[] = [
  ...DJANGO.map((django) => preview(`${django} makemigrations`, '--dry-run')),
  ...DJANGO.map((django) => preview(`${django} migrate`, '--check --plan')),
  preview('uv lock', '--check --dry-run'),
  preview('uv sync', '--check --dry-run'),
  preview('uv pip install', '--dry-run'),
  preview('npm install', '--dry-run'),
  preview('npm uninstall', '--dry-run'),
  preview('npm update', '--dry-run'),
  preview('cargo add', '--dry-run'),
  preview('cargo remove', '--dry-run'),
  preview('cargo update', '--dry-run'),
  preview('pip install', '--dry-run'),
  preview('pip3 install', '--dry-run'),
  ...['add', 'remove', 'lock', 'install', 'update', 'sync'].map((sub) =>
    preview(`poetry ${sub}`, '--dry-run'),
  ),
  preview('rake', '--dry-run -n'),
];

/**
 * Whether one plain reading, from its program on, is a hazard command given one of its preview
 * flags: the flag follows the command's last word, before any `--`, and is no flag's value.
 */
function previews(reading: readonly PlainWord[], words: readonly string[]): boolean {
  const [program] = reading;
  if (program === undefined) return false;
  const named = (word: string, at: number): string =>
    at === 0
      ? commandName(word)
      : reading[0]?.word === 'npm' && at === 1
        ? (NPM_ALIASES.get(word) ?? word)
        : word;
  const flags = FLAG_TABLES.get(commandName(program.word));
  const takesValue = (flag: string): boolean =>
    flags === undefined ? GENERIC_VALUE_FLAGS.has(flag) : flags.values.has(flag);
  return PREVIEWS.some((p) => {
    if (
      !p.words.every(
        (word, at) => reading[at] !== undefined && named(reading[at].word, at) === word,
      )
    ) {
      return false;
    }
    const last = reading[p.words.length - 1]?.at ?? words.length;
    for (let at = last + 1; at < words.length && words[at] !== '--'; at += 1) {
      if (p.flags.has(words[at] ?? '') && !takesValue(words[at - 1] ?? '')) return true;
    }
    return false;
  });
}

/** In a hazard pattern, a word that matches any one word, such as a container's name. */
export const ANY_WORD = '\u0002';
/** Stands for a word 10db cannot read, which may become any words. */
export const UNREAD_WORD = '\u0000';
/** Stands for a quoted expansion, which the shell passes as exactly one word, whatever it holds. */
export const ONE_WORD = '\u0001';

/**
 * The word sequences that make a command a hazard, as `hazardHit` compares them: each hazard's
 * command, and that command run through a runner such as `pnpm exec`. Taken from the project's
 * hazards, so a custom command is covered the same way as the defaults.
 */
export function hazardPatterns(commands: readonly (readonly string[])[]): string[][] {
  // A runner's operands (the service or container) are any word.
  const through = (runner: Runner, rest: readonly (readonly string[])[]): string[][] =>
    rest.map((c) => [...runner.words, ...Array<string>(runner.operands).fill(ANY_WORD), ...c]);
  const once = RUNNERS.flatMap((runner) => through(runner, commands));
  // A container runner may run another runner: `docker compose exec backend uv run python x`.
  const twice = RUNNERS.filter((runner) => runner.container).flatMap((outer) =>
    through(
      outer,
      RUNNERS.flatMap((inner) => through(inner, commands)),
    ),
  );
  return [...commands.map((c) => [...c]), ...once, ...twice];
}

/**
 * Whether the words may start with the pattern once each unread word is read as whatever fits. An
 * unread word reached before the pattern ends can supply the rest of it. A one-word stand-in that is
 * still a plain word could be a flag or a word of the pattern, so it is unread too; it only helps
 * where a flag's value slot swallows it.
 */
export function mayStartWith(words: readonly string[], pattern: readonly string[]): boolean {
  for (let at = 0; at < pattern.length; at += 1) {
    const word = words[at];
    if (word === undefined) return false;
    if (word === UNREAD_WORD || word === ONE_WORD) return true;
    if (pattern[at] !== ANY_WORD && word !== pattern[at]) return false;
  }
  return true;
}
