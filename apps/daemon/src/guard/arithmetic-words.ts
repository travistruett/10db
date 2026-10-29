/**
 * Where the shell evaluates a word as arithmetic. Bash evaluates a bare identifier there as the
 * variable it names, and a variable's value as an expression again, so `n='a[$(cmd)]'; echo $((n))`
 * runs `cmd` with no `$` in the arithmetic. An expression is read only when it is a number or an
 * operator; anything else is unread.
 */

/** A hexadecimal literal; the letters are digits, not names. */
const HEX_LITERAL = /0[xX][0-9a-fA-F]+/g;
/** Digits and the operators of arithmetic, with whitespace. */
const NUMERIC = /^[\d\s+\-*/%()<>=!&|^~?:,]*$/;
/** A bare variable name. */
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A parameter expansion or backtick, whose value the shell may evaluate as arithmetic. */
const EXPANSION = /[$`]/;

/** Whether an expression holds only numeric literals and operators. */
export function isNumericExpression(expression: string): boolean {
  return NUMERIC.test(expression.replace(HEX_LITERAL, '0'));
}

/** A subscript that is safe to evaluate: a number, or `@` and `*` for all elements. */
const safeSubscript = (subscript: string): boolean =>
  subscript === '@' || subscript === '*' || isNumericExpression(subscript);

/**
 * Whether a word holds an arithmetic context the scan cannot read, in any command: an arithmetic
 * expansion, `$[…]`, a subscript on a name being assigned or expanded, or a substring offset.
 */
export function unreadArithmeticIn(word: string): boolean {
  const expansion = /\$\(\((.*)\)\)/s.exec(word);
  if (expansion !== null && !isNumericExpression(expansion[1] ?? '')) return true;
  const bracket = /\$\[(.*)\]/s.exec(word);
  if (bracket !== null && !isNumericExpression(bracket[1] ?? '')) return true;
  const element = /\$\{#?[A-Za-z_]\w*\[([^\]]*)\]/.exec(word);
  if (element !== null && !safeSubscript(element[1] ?? '')) return true;
  const assigned = /^[A-Za-z_]\w*\[([^\]]*)\]\+?=/.exec(word);
  if (assigned !== null && !safeSubscript(assigned[1] ?? '')) return true;
  const offset = /\$\{[A-Za-z_]\w*:(?![-=+?])([^}]*)\}/.exec(word);
  if (offset !== null && !isNumericExpression(offset[1] ?? '')) return true;
  // An expansion inside any subscript or offset, whatever the rest says.
  return /\[[^\]]*[$`]/.test(word) || /\$\{[^}]*:(?![-=+?])[^}]*[$`]/.test(word);
}

const TEST_COMMANDS: ReadonlySet<string> = new Set(['[[', '[', 'test']);
const NUMBER_TESTS: ReadonlySet<string> = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);
const NAME_TESTS: ReadonlySet<string> = new Set(['-v', '-R']);
const EVALUATING: ReadonlySet<string> = new Set(['read', 'unset', 'getopts']);
const DECLARING: ReadonlySet<string> = new Set([
  'declare',
  'typeset',
  'local',
  'export',
  'readonly',
]);

/** The part of an assignment word after its `name=`, `name+=` or `name<op>=`, or the word. */
const valueOf = (word: string): string =>
  word.replace(/^[A-Za-z_]\w*(?:\+|-|\*|\/|%|&|\||\^|<<|>>)?=/, '');

/** The `declare -i` family: a command that gives a variable the integer attribute. */
export function declaresInteger(head: string, words: readonly string[]): boolean {
  if (head === 'integer') return true;
  return DECLARING.has(head) && words.slice(1).some((word) => /^-[a-zA-Z]*i/.test(word));
}

/**
 * Whether a builtin evaluates its words as arithmetic or as a variable name with a subscript, and
 * one of them is not a plain number or name. `printf -v` takes a name, and `let` an expression.
 */
export function evaluatesUnread(head: string, words: readonly string[]): boolean {
  const args = words.slice(1);
  if (TEST_COMMANDS.has(head)) {
    return args.some((word, at) => {
      const next = args[at + 1] ?? '';
      const previous = args[at - 1] ?? '';
      if (NUMBER_TESTS.has(word))
        return !isNumericExpression(previous) || !isNumericExpression(next);
      return NAME_TESTS.has(word) && !PLAIN_NAME.test(next);
    });
  }
  if (head === 'let') return args.some((word) => !isNumericExpression(valueOf(word)));
  if (head === 'printf') {
    return args.includes('-v') && args.some((word) => EXPANSION.test(word) || word.includes('['));
  }
  if (EVALUATING.has(head)) {
    return args.some((word) => EXPANSION.test(word) || !safeNames(word));
  }
  if (DECLARING.has(head)) {
    const integer = declaresInteger(head, words);
    return args.some((word) => {
      if (word.startsWith('-')) return false;
      if (integer && word.includes('=') && !isNumericExpression(valueOf(word))) return true;
      return EXPANSION.test(word) || !safeNames(word.split('=')[0] ?? word);
    });
  }
  return false;
}

/** Whether every subscript in a variable name is safe to evaluate. */
function safeNames(name: string): boolean {
  return [...name.matchAll(/\[([^\]]*)\]/g)].every((m) => safeSubscript(m[1] ?? ''));
}

/** Whether an assignment word's value is not a plain number, for a variable that may be an integer. */
export function assignsUnreadInteger(word: string): boolean {
  return /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(word) && !isNumericExpression(valueOf(word));
}
