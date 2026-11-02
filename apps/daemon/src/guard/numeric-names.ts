import { expandsIndirectly, isNumericExpression } from './arithmetic-words';
import { commandName, leadingWords, parseShell, stripCommandPrefixes } from './shell-words';

/**
 * Variables a command sets only to numbers, so the shell reading one in arithmetic (`$((t - s))`)
 * evaluates a number and nothing else. Bash evaluates a bare name in arithmetic as the variable it
 * names, and that variable's value as an expression again, so a name holding `a[$(cmd)]` runs `cmd`.
 * A name is safe when every way the command can set it is a plain `name=value` whose value is a
 * number by construction: digits, `$?`, `$#`, `$$`, `$!`, `$(date +%s)`, `$((…))` over numbers and
 * names that are themselves safe, or one of those names. The environment the command starts with
 * is not the command's text and is trusted, as it is everywhere else in the guard.
 */

const MAX_DEPTH = 4;
const ASSIGNMENT = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/;
const ARITHMETIC_VALUE = /^\$\(\(([\s\S]*)\)\)$|^\$\[([\s\S]*)\]$/;
const NUMBER_VALUE = /^(?:\d*|\$(?:[?#$!]|\{[?#$!]\})|\$\(date \+%s\))$/;
const NAME_VALUE = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/;
/** An operator that sets a name inside arithmetic. */
const ASSIGNING_OPERATOR = '(?:[-+*/%&|^]|<<|>>)?=(?!=)';

/**
 * Words that run text this scan does not follow, or define what a later command means. A command
 * holding one has no safe name: a shell or `eval` can set a name from text the scan does not read.
 */
const UNFOLLOWED: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'eval',
  'source',
  '.',
  'coproc',
  'trap',
  'alias',
  'function',
  'builtin',
  'find',
  'xargs',
  'parallel',
]);

/**
 * Every builtin bash has, with `[[` and `select`, the keywords that set names, and the same for
 * zsh, the shell lanes run commands in on macOS (`login-env.ts` defaults `SHELL` to `/bin/zsh`):
 * its own builtins, those of the modules it loads (`zsh/datetime`, `zsh/stat`, `zsh/system`,
 * `zsh/zutil` and the rest, loaded by `zmodload`, which is itself on this list), and its keywords
 * that run or set (`foreach`, `repeat`, `noglob`, `nocorrect`). A command named by one of these is
 * understood only when it is in `UNDERSTOOD`; a command that is not a builtin (`make`, `pnpm`,
 * `node`) runs a program in its own process, which cannot set the shell's names. The other
 * keywords (`for`, `while`, `if` and the rest) set no name but one they name as a word.
 */
const BUILTINS: ReadonlySet<string> = new Set(
  // bash
  (
    '. : [ [[ alias bg bind break builtin caller cd command compgen complete compopt continue ' +
    'declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history ' +
    'jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return select set ' +
    'shift shopt source suspend test time times trap true type typeset ulimit umask unalias unset wait ' +
    // zsh builtins
    'autoload bindkey builtin bye chdir comparguments compcall compctl compdescribe compfiles ' +
    'compgroups compquote comptags comptry compvalues disable echotc echoti emulate float functions ' +
    'getcap getln integer limit log noglob nocorrect print private pushln r rehash sched setcap ' +
    'setopt stat unfunction unhash unlimit unsetopt vared whence where which zcompile zformat ' +
    'zftp zle zmodload zparseopts zprof zpty zregexparse zsocket zstyle ztcp ' +
    // zsh keywords that set a name or run a command
    'foreach repeat ' +
    // zsh module builtins and the completion builtins
    'compadd compset strftime zstat sysread syswrite sysopen sysseek systell syserror zselect ' +
    'zsystem zgetattr zsetattr zdelattr zlistattr pcre_compile pcre_match pcre_study ztie ' +
    'zuntie zcurses compdef compinit'
  ).split(' '),
);

/**
 * The builtins this scan reads: each sets a name by naming it as a word (`read s`, `unset s`,
 * `let s=…`, `export s=…`), which `setsName` sees, or sets only names in `IMPLICIT`. Every other builtin (`getopts`, `mapfile -C`,
 * `enable`, `hash`, `history`, `vared`, `zparseopts` and the rest) may set or run something the
 * scan does not read, so a command naming one has no safe name. `command`, `exec` and `time` run
 * the command after them, which is checked in turn. `declare`, `typeset`, `local` and their zsh
 * kin `integer`, `float` and `private` are read except for a nameref or a flag the scan cannot
 * read, `printf` except for `-v`, and `print` except for a flag cluster with `v`, which sets a
 * name. `whence`, `where` and `which` only report. `repeat` runs the command after its count, and
 * zsh's `-` modifier the command after it; `commandHeads` reads that command in turn. `foreach` sets its variable from a word list the scan does
 * not read, so it is not understood.
 */
const UNDERSTOOD: ReadonlySet<string> = new Set(
  (
    ': [ [[ break cd chdir command continue declare echo exec exit export false float ' +
    'integer jobs let local popd print printf private pushd pwd read readonly repeat return ' +
    'select set shift shopt test time true type typeset unset wait whence where which'
  ).split(' '),
);

/**
 * Names a builtin or keyword sets without naming them as a word: `read` and `select` with no name
 * write `REPLY` (zsh `read -A`, `-c` and `-l` write `reply`); `cd`, `pushd` and `popd` write
 * `PWD`, `OLDPWD` and `DIRSTACK` (zsh's `dirstack`); `=~` writes `BASH_REMATCH` in bash and
 * `MATCH`, `match`, `MBEGIN` and `MEND` in zsh. The scan treats them as set to text whenever the
 * word appears, with a named operand or without.
 */
const DIRECTORY_NAMES = ['PWD', 'OLDPWD', 'DIRSTACK', 'dirstack'];
const IMPLICIT: ReadonlyMap<string, readonly string[]> = new Map([
  ['read', ['REPLY', 'reply']],
  ['select', ['REPLY']],
  ['cd', DIRECTORY_NAMES],
  ['chdir', DIRECTORY_NAMES],
  ['pushd', DIRECTORY_NAMES],
  ['popd', DIRECTORY_NAMES],
  ['=~', ['BASH_REMATCH', 'MATCH', 'match', 'MBEGIN', 'MEND']],
]);

const NAMEREF_BUILTINS: ReadonlySet<string> = new Set([
  'declare',
  'typeset',
  'local',
  'integer',
  'float',
  'private',
]);

interface Assignment {
  readonly name: string;
  readonly value: string;
}

interface Collected {
  readonly assignments: Assignment[];
  /** Every word that is not the name and value of a plain assignment before a command. */
  readonly others: string[];
  /** Names an assignment sets in a form this scan does not read. */
  readonly spoiled: Set<string>;
  /** Every word, assignments included. */
  readonly all: string[];
  /** The words of each command, after its leading assignments. */
  readonly commands: string[][];
}

/** Gathers every segment of the command and of the substitutions in it; false when it cannot be read. */
function collect(command: string, depth: number, into: Collected, arithmetic = false): boolean {
  if (depth > MAX_DEPTH) return false;
  const parse = parseShell(command);
  if (!parse.certain) return false;
  for (const segment of parse.segments) {
    if (!segment.wordsCertain || !segment.bracesCertain || segment.processSubstitution)
      return false;
    if (arithmetic) {
      // The words are the expression, which the word holding it already stands for.
      for (const body of segment.nested) {
        if (!collect(body, depth + 1, into)) return false;
      }
      continue;
    }
    const offset = segment.words.length - leadingWords(segment.words).command.length;
    let at = offset;
    for (; at < segment.words.length; at += 1) {
      const match = ASSIGNMENT.exec(segment.words[at] ?? '');
      if (match === null) break;
      const name = match[1] ?? '';
      // `name+=value` appends text, which the scan does not read.
      if (match[2] === '+') into.spoiled.add(name);
      else into.assignments.push({ name, value: match[3] ?? '' });
    }
    into.others.push(...segment.words.slice(0, offset), ...segment.words.slice(at));
    into.all.push(...segment.words);
    into.commands.push(segment.words.slice(at));
    for (const body of segment.nested) {
      // The parser hands `$((expr))` over as the subshell `(expr)`.
      const isArithmetic =
        body.startsWith('(') &&
        body.endsWith(')') &&
        segment.words.some((word) => word.includes(`$((${body.slice(1, -1)}))`));
      if (!collect(body, depth + 1, into, isArithmetic)) return false;
    }
  }
  return true;
}

/**
 * Whether a nested body is the `(expr)` the parser makes of a `$((expr))` in one of the words, with
 * an `expr` that holds only numbers, so the shell evaluates it as arithmetic and runs nothing.
 */
export function isNumericArithmetic(
  body: string,
  words: readonly string[],
  names: ReadonlySet<string>,
): boolean {
  if (!body.startsWith('(') || !body.endsWith(')')) return false;
  const expression = body.slice(1, -1);
  return (
    isNumericExpression(expression, names) &&
    words.some((word) => word.includes(`$((${expression}))`))
  );
}

/**
 * Whether a command can rebind a name in a way `setsName` does not see: a nameref (`declare -n r=s`
 * makes `r=…` write `s`), a flag the scan cannot read, `printf -v`, or a builtin it does not understand.
 */
function rebindsNames(words: readonly string[]): boolean {
  const { heads, command } = commandHeads(words);
  if (heads.some((head) => BUILTINS.has(head) && !UNDERSTOOD.has(head))) return true;
  // A declaring builtin anywhere in the command, behind any wrapper, with a flag naming `n`, or a
  // word the shell expands that is not an assignment, which may expand to a flag: `declare -gn r=s`,
  // `declare -$f r`, `declare $x r=s`, `local +n r`.
  if (words.some((word) => NAMEREF_BUILTINS.has(commandName(word)))) {
    if (words.some((word) => /^[-+]/.test(word) && word.includes('n'))) return true;
    if (words.some((word) => !ASSIGNMENT.test(word) && /[$`]/.test(word))) return true;
  }
  if (heads.includes('printf') && words.some((word) => word.startsWith('-v'))) return true;
  // zsh `print -v name` stores the text in `name`; the flags may be a cluster (`-rv`) or carry the name.
  if (heads.includes('print') && words.some((word) => /^-[a-zA-Z]*v/.test(word))) return true;
  // A word the shell expands where print or printf still reads options may expand to `-v`:
  // `F=-v; print $F s x` sets `s`.
  const head = commandName(command[0] ?? '');
  return (head === 'print' || head === 'printf') && expandsInOptions(command.slice(1));
}

/** Whether a word in option position (before `--`, `-` or the first operand) is expanded. */
function expandsInOptions(args: readonly string[]): boolean {
  for (const word of args) {
    if (word === '--' || word === '-') return false;
    if (/[$`]/.test(word)) return true;
    if (!word.startsWith('-')) return false;
  }
  return false;
}

/**
 * Every word that may name the command a segment runs: the first word, the word after `command`,
 * `exec`, `time` and the runners `stripCommandPrefixes` knows, and the word after zsh's `repeat N`
 * and `-` precommand modifier, in any nesting. `command` is the words of the command finally run.
 */
function commandHeads(words: readonly string[]): { heads: string[]; command: readonly string[] } {
  const heads: string[] = [];
  let rest = words;
  for (;;) {
    heads.push(commandName(rest[0] ?? ''));
    const stripped = stripCommandPrefixes(rest, {
      lookThroughRunners: true,
      skipRedirections: true,
      keepCommandPath: true,
    });
    const head = commandName(stripped[0] ?? '');
    heads.push(head);
    if (head === 'repeat') rest = stripped.slice(2);
    else if (head === '-') rest = stripped.slice(1);
    else return { heads, command: stripped };
    if (rest.length === 0) return { heads, command: rest };
  }
}

/** Whether a word sets or rebinds `name` in a way other than a plain assignment before a command. */
function setsName(word: string, name: string, arithmetic: boolean): boolean {
  if (word === name || word.startsWith(`${name}=`) || word.startsWith(`${name}+=`)) return true;
  if (word.startsWith(`${name}[`)) return true;
  // `${name:=x}`, `${name=x}`, `${name[0]}`, `${name%x}`: anything but the plain `${name}` read,
  // behind any zsh flags and prefix characters (`${(L)name::=x}`, `${=name::=x}`, `${^name:=x}`).
  if (new RegExp(`\\$\\{(?:\\([^)]*\\)|[=~^+#])*${name}(?![\\w}])`).test(word)) return true;
  if (!arithmetic) return false;
  const bare = `(?<![\\w$])${name}(?!\\w)`;
  return [
    `${bare}\\s*${ASSIGNING_OPERATOR}`,
    `${bare}\\s*(?:\\+\\+|--)`,
    `(?:\\+\\+|--)\\s*${bare}`,
    `${bare}\\s*\\[`,
  ].some((pattern) => new RegExp(pattern).test(word));
}

/** Whether the value of an assignment is a number given the names already known to hold numbers. */
function numericValue(value: string, names: ReadonlySet<string>): boolean {
  if (NUMBER_VALUE.test(value)) return true;
  const arithmetic = ARITHMETIC_VALUE.exec(value);
  if (arithmetic !== null) return isNumericExpression(arithmetic[1] ?? arithmetic[2] ?? '', names);
  const read = NAME_VALUE.exec(value);
  return read !== null && names.has(read[1] ?? read[2] ?? '');
}

/** The names `command` sets only to numbers, or none when it holds text this scan cannot follow. */
export function numericNames(command: string): ReadonlySet<string> {
  const into: Collected = {
    assignments: [],
    others: [],
    spoiled: new Set(),
    all: [],
    commands: [],
  };
  const none: ReadonlySet<string> = new Set();
  try {
    if (!collect(command, 0, into)) return none;
  } catch (cause) {
    if (cause instanceof RangeError) return none;
    throw cause;
  }
  if (into.all.some((word) => UNFOLLOWED.has(commandName(word)))) return none;
  // `${!name}` reads the variable another one names; `name() {` defines a function whose body runs
  // later; either can reach a name by a path the scan does not follow.
  if (into.all.some((word) => expandsIndirectly(word) || word.includes('()'))) return none;
  if (into.commands.some(rebindsNames)) return none;
  for (const word of into.all) {
    for (const name of IMPLICIT.get(commandName(word)) ?? []) into.spoiled.add(name);
  }
  const inArithmetic = (word: string): boolean => word.includes('$((') || word.includes('$[');
  const setElsewhere = (name: string): boolean =>
    into.spoiled.has(name) ||
    into.others.some((word) => setsName(word, name, inArithmetic(word))) ||
    into.assignments.some((a) => setsName(a.value, name, inArithmetic(a.value)));
  const names = new Set(
    into.assignments.map((assignment) => assignment.name).filter((name) => !setElsewhere(name)),
  );
  // Drop a name with a value that is not a number, until what is left depends on nothing dropped.
  for (let changed = true; changed;) {
    changed = false;
    for (const assignment of into.assignments) {
      if (names.has(assignment.name) && !numericValue(assignment.value, names)) {
        names.delete(assignment.name);
        changed = true;
      }
    }
  }
  return names;
}
