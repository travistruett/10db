/**
 * Programs that run the command or the code they are given: shells, language runtimes and the
 * wrappers that hand their arguments to another program. A permission rule that names one allows
 * whatever follows it, so a project can't allow one as a prefix, and "always allow" keeps the whole
 * command for one. The daemon and the allowed-commands check read this one list so they can't drift.
 */
const RUNNERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'node',
  'nodejs',
  'deno',
  'ruby',
  'perl',
  'php',
  'lua',
  'awk',
  'gawk',
  'tclsh',
  'osascript',
  'env',
  'xargs',
  'sudo',
  'su',
  'doas',
  'eval',
  'exec',
  'command',
  'nohup',
  'time',
  'timeout',
  'nice',
  'caffeinate',
  'arch',
  'watch',
  'script',
]);
/** Python and PyPy are named by version too: `python3` and `pypy3.11` both run code. */
const PYTHON_NAMES = /^(?:python|pypy)[\d.]*$/;

/**
 * Whether a program, given by its name on PATH rather than a path, runs the command or code it is
 * given. Names are compared without case: a case-insensitive file system resolves `NODE` to `node`.
 */
export function isCommandRunner(program: string): boolean {
  const name = program.toLowerCase();
  return RUNNERS.has(name) || PYTHON_NAMES.test(name);
}

/** Package managers, which run a script or a package they are named with. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Tools that fetch a package by name and run it: `npx prettier` runs prettier. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'bunx', 'pnpx', 'dlx']);
/** Subcommands that run the program named after them: `pnpm exec prettier` names one, `pnpm exec` names none. */
const PROGRAM_SUBCOMMANDS: ReadonlySet<string> = new Set(['exec', 'dlx', 'x']);

/**
 * Whether a package tool, given by its name on PATH, runs the package or script it is named with.
 * Names are compared without case.
 */
export function isPackageTool(program: string): boolean {
  const name = program.toLowerCase();
  return PACKAGE_MANAGERS.has(name) || PACKAGE_RUNNERS.has(name);
}

/**
 * The position in `words` of the program that a package tool runs: `pnpm exec X` and `npm x X` name it
 * third, `npx X` second. Null when the words name no program that way. Names are compared without case.
 */
export function packageToolProgramIndex(words: readonly string[]): number | null {
  const [first = '', second = ''] = words;
  const name = first.toLowerCase();
  if (PACKAGE_MANAGERS.has(name) && PROGRAM_SUBCOMMANDS.has(second.toLowerCase())) return 2;
  if (PACKAGE_RUNNERS.has(name)) return 1;
  return null;
}

/**
 * Subcommands that hand the rest of the line to another command or to each workspace in turn: `yarn
 * workspace web exec bash` runs bash, and `pnpm recursive exec` runs anything. A prefix that stops at one
 * covers whatever follows it. `pnpm multi` and `pnpm m` are other names for `pnpm recursive`.
 */
const FORWARDING_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['yarn', new Set(['workspace', 'workspaces', 'node'])],
  ['pnpm', new Set(['recursive', 'multi', 'm'])],
]);
/**
 * Subcommands that fetch the package named after them and run it: `npm create vite` runs create-vite.
 * Bare, they run whichever package is named later, so a prefix that stops at one covers all of them.
 * `npm innit` is another name for `npm init`, and `bun c` for `bun create`.
 */
const PACKAGE_CREATORS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['npm', new Set(['init', 'create', 'innit'])],
  ['pnpm', new Set(['create'])],
  ['yarn', new Set(['create'])],
  ['bun', new Set(['create', 'c'])],
]);

/**
 * Whether the words run another command or a package they name through a subcommand of a package tool:
 * the forwarding subcommands and the package creators. Names are compared without case.
 */
export function packageToolForwards(words: readonly string[]): boolean {
  const [first = '', second = ''] = words;
  const name = first.toLowerCase();
  const subcommand = second.toLowerCase();
  return (
    FORWARDING_SUBCOMMANDS.get(name)?.has(subcommand) === true ||
    PACKAGE_CREATORS.get(name)?.has(subcommand) === true
  );
}
