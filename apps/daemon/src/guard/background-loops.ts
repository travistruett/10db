import { basename } from 'node:path';

/**
 * Finds a command that starts something that never ends in the background: a `while :` loop, `yes`,
 * `cat /dev/zero` and the like, followed by an ampersand. Such a process outlives the command that
 * started it, and a lane that is stopped first leaves it burning a core (a lane once did this with
 * twelve busy loops). The scan is a heuristic over a command's text, not a shell: it reads quotes,
 * comments and operators, follows `sh -c` and `eval` scripts, and errs toward asking.
 */

/** How many levels of `sh -c` and `eval` are followed; deeper than this counts as endless. */
const MAX_DEPTH = 4;

interface Token {
  readonly kind: 'word' | 'op';
  readonly value: string;
}

/** Cuts a command into words (quotes removed) and operators. Linear: each character is read once. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let word = '';
  let inWord = false;
  const flush = (): void => {
    if (inWord) tokens.push({ kind: 'word', value: word });
    word = '';
    inWord = false;
  };
  const op = (value: string): void => {
    flush();
    tokens.push({ kind: 'op', value });
  };
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (ch === '\\') {
      if (next !== '\n') {
        word += next;
        inWord = true;
      }
      i += 2;
    } else if (ch === "'" || (ch === '$' && next === "'")) {
      const ansi = ch === '$';
      i += ansi ? 2 : 1;
      inWord = true;
      while (i < text.length && text.charAt(i) !== "'") {
        if (ansi && text.charAt(i) === '\\') i += 1;
        word += text.charAt(i);
        i += 1;
      }
      i += 1;
    } else if (ch === '"') {
      i += 1;
      inWord = true;
      while (i < text.length && text.charAt(i) !== '"') {
        if (text.charAt(i) === '\\' && i + 1 < text.length) i += 1;
        word += text.charAt(i);
        i += 1;
      }
      i += 1;
    } else if (ch === '#' && !inWord) {
      while (i < text.length && text.charAt(i) !== '\n') i += 1;
    } else if (ch === ' ' || ch === '\t') {
      flush();
      i += 1;
    } else if (ch === '\n') {
      op('\n');
      i += 1;
    } else if (ch === ';') {
      op(next === ';' ? ';;' : ';');
      i += next === ';' ? 2 : 1;
    } else if (ch === '(' || ch === ')') {
      op(ch);
      i += 1;
    } else if (ch === '|') {
      // `|&` pipes stderr too: still a pipe.
      const pair = next === '|' || next === '&';
      op(next === '|' ? '||' : '|');
      i += pair ? 2 : 1;
    } else if (ch === '&') {
      const previous = text.charAt(i - 1);
      if (previous === '>' || previous === '<' || next === '>') {
        // `2>&1`, `<&3` and `&>file` are redirections, part of a word.
        word += ch;
        inWord = true;
        i += 1;
      } else if (next === '&') {
        op('&&');
        i += 2;
      } else {
        // zsh's `&!` and `&|` background and disown.
        op('&');
        i += next === '!' || next === '|' ? 2 : 1;
      }
    } else {
      word += ch;
      inWord = true;
      i += 1;
    }
  }
  flush();
  return tokens;
}

/** Words that leave the next word still in command position. */
const PREFIX_WORDS = new Set([
  '{',
  '!',
  'time',
  'do',
  'then',
  'else',
  'elif',
  'nohup',
  'exec',
  'command',
  'builtin',
  'nice',
  'setsid',
  'env',
  'stdbuf',
  'caffeinate',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'perl', 'ruby', 'php', 'awk']);
const ENDLESS_FILES = new Set(['/dev/zero', '/dev/urandom', '/dev/random']);
/** A loop that never ends, written in an interpreter's one-liner. Each repeat is bounded or literal-separated. */
const INTERPRETER_LOOP =
  /\bwhile[ \t(]{1,8}(?:true|True|1)\b|\bfor[ \t]*\([ \t]*;[ \t]*;|\bloop[ \t]*\{|\b1 while 1\b|\bwhile[ \t]*:/;

const OPERATORS_END_CONDITION = new Set([';', '\n']);

function isEndlessCondition(cond: readonly Token[], until: boolean): boolean {
  const compact = cond.map((t) => t.value).join('');
  const words = cond.filter((t) => t.kind === 'word').map((t) => t.value);
  if (cond.some((t) => t.kind === 'op' && t.value !== '(' && t.value !== ')')) return false;
  const arithmetic = /^\(\(([0-9]+)\)\)$/.exec(compact);
  if (arithmetic !== null) return until ? Number(arithmetic[1]) === 0 : Number(arithmetic[1]) !== 0;
  const head = basename(words[0] ?? '');
  if (until) return head === 'false';
  if (head === ':' || head === 'true') return true;
  if (head === 'test' || head === '[' || head === '[[') {
    const operands = words.slice(1).filter((w) => w !== ']' && w !== ']]');
    const constant = /^[A-Za-z0-9_.-]+$/;
    const [a, relation, b] = operands;
    if (operands.length === 1) return constant.test(a ?? '');
    if (operands.length === 3) {
      return a === b && constant.test(a ?? '') && ['=', '==', '-eq'].includes(relation ?? '');
    }
  }
  return false;
}

function isEndlessForParens(tokens: readonly Token[], from: number): boolean {
  let depth = 0;
  let text = '';
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.kind === 'op' && token.value === '(') depth += 1;
    if (token.kind === 'op' && token.value === ')') depth -= 1;
    text += token.value;
    if (depth === 0) break;
  }
  return /^\(\([^;]*;(?:1|true)?;[^;]*\)\)$/.test(text);
}

interface Scan {
  readonly endless: boolean;
  readonly flagged: boolean;
}

function scan(text: string, depth: number): Scan {
  if (depth > MAX_DEPTH) return { endless: true, flagged: false };
  const tokens = tokenize(text);
  let endless = false;
  let background = false;
  let flagged = false;
  let atCommand = true;
  /** The words after `from`, up to the next operator. */
  const argsFrom = (from: number): string[] => {
    const args: string[] = [];
    for (let j = from; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (token === undefined || token.kind === 'op') break;
      args.push(token.value);
    }
    return args;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.kind === 'op') {
      if (token.value === '&') background = true;
      atCommand = true;
      continue;
    }
    if (!atCommand) continue;
    const name = basename(token.value);
    if (token.value === 'coproc') {
      background = true;
      continue;
    }
    if (PREFIX_WORDS.has(token.value) || ASSIGNMENT.test(token.value)) continue;
    atCommand = false;
    if (token.value === 'while' || token.value === 'until') {
      const cond: Token[] = [];
      for (let j = i + 1; j < tokens.length; j += 1) {
        const next = tokens[j];
        if (next === undefined) break;
        if (next.kind === 'word' && next.value === 'do') break;
        if (next.kind === 'op' && OPERATORS_END_CONDITION.has(next.value)) break;
        cond.push(next);
      }
      if (isEndlessCondition(cond, token.value === 'until')) endless = true;
      atCommand = true;
      i += cond.length;
    } else if (token.value === 'for') {
      const opens = tokens[i + 1]?.value === '(' && tokens[i + 2]?.value === '(';
      if (opens && isEndlessForParens(tokens, i + 1)) endless = true;
    } else if (name === 'yes') {
      endless = true;
    } else if (name === 'cat') {
      if (argsFrom(i + 1).some((a) => ENDLESS_FILES.has(a))) endless = true;
    } else if (name === 'dd') {
      const args = argsFrom(i + 1);
      const reads = args.some((a) => a.startsWith('if=') && ENDLESS_FILES.has(a.slice(3)));
      if (reads && !args.some((a) => a.startsWith('count='))) endless = true;
    } else if (SHELLS.has(name)) {
      const args = argsFrom(i + 1);
      const at = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      const script = at < 0 ? undefined : args[at + 1];
      if (script !== undefined) {
        const nested = scan(script, depth + 1);
        endless ||= nested.endless;
        flagged ||= nested.flagged;
      }
    } else if (name === 'eval') {
      const nested = scan(argsFrom(i + 1).join(' '), depth + 1);
      endless ||= nested.endless;
      flagged ||= nested.flagged;
    } else if (INTERPRETERS.has(name)) {
      const args = argsFrom(i + 1);
      if (args.some((a) => INTERPRETER_LOOP.test(a))) endless = true;
    }
  }
  return { endless, flagged: flagged || (endless && background) };
}

/**
 * True when the command runs something that never ends and puts it in the background, so it would
 * outlive the command. A loop or program that runs in the foreground is not flagged: the command
 * ends when it does, or the tool's timeout stops it.
 */
export function startsEndlessBackgroundLoop(command: string): boolean {
  return scan(command, 0).flagged;
}
