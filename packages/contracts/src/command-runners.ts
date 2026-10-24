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
