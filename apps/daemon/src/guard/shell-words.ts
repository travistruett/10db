export interface ShellSegment {
  /** The segment's text with quotes kept, for quote-aware checks. */
  readonly raw: string;
  /** Words with quotes removed. */
  readonly words: string[];
  /** The operator that ended the segment: `&&`, `||`, `;`, `|`, newline, or empty at the end. */
  readonly separator: string;
}

/**
 * Splits a shell command at unquoted `&&`, `||`, `;`, `|` and newlines. The bodies of `$(…)` and
 * backtick substitutions (outside single quotes) are split too and appended as their own
 * segments, because they run as commands.
 */
export function splitCommand(command: string): ShellSegment[] {
  const out: ShellSegment[] = [];
  const nested: string[] = [];
  let raw = '';
  let word = '';
  let words: string[] = [];
  let quote: "'" | '"' | null = null;

  const flushWord = (): void => {
    if (word !== '') words.push(word);
    word = '';
  };
  const flushSegment = (separator: string): void => {
    flushWord();
    if (raw.trim() !== '') out.push({ raw: raw.trim(), words, separator });
    raw = '';
    words = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    if (quote !== "'" && ch === '$' && next === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command.charAt(j) === '(') depth += 1;
        if (command.charAt(j) === ')') depth -= 1;
        j += 1;
      }
      const body = command.slice(i + 2, j - 1);
      nested.push(body);
      raw += command.slice(i, j);
      word += command.slice(i, j);
      i = j - 1;
      continue;
    }
    if (quote !== "'" && ch === '`') {
      const end = command.indexOf('`', i + 1);
      const close = end === -1 ? command.length : end;
      nested.push(command.slice(i + 1, close));
      raw += command.slice(i, close + 1);
      word += command.slice(i, close + 1);
      i = close;
      continue;
    }
    if (quote) {
      raw += ch;
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      raw += ch;
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      flushSegment(ch + next);
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      flushSegment(ch);
      continue;
    }
    raw += ch;
    if (ch === ' ' || ch === '\t') flushWord();
    else word += ch;
  }
  flushSegment('');
  for (const body of nested) out.push(...splitCommand(body));
  return out;
}

const PREFIX_COMMANDS = new Set(['env', 'command', 'nohup', 'time', 'exec']);

/** Drops leading `VAR=value` assignments and pass-through wrappers such as `env` and `nohup`. */
export function stripCommandPrefixes(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PREFIX_COMMANDS.has(w)) i += 1;
    else break;
  }
  return words.slice(i);
}
