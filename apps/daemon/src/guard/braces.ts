const MAX_BRACE_GROUPS = 32;
const MAX_BRACE_ALTERNATIVES = 64;

/** Splits `text` at the commas that are not inside a nested brace. */
function topLevelAlternatives(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function expandGroups(pattern: string): string[] | null {
  const open = pattern.indexOf('{');
  if (open === -1) return pattern.includes('}') ? null : [pattern];
  let depth = 0;
  let close = -1;
  for (let index = open; index < pattern.length && close === -1; index += 1) {
    if (pattern[index] === '{') depth += 1;
    else if (pattern[index] === '}') {
      depth -= 1;
      if (depth === 0) close = index;
    }
  }
  if (close === -1) return null;
  const body = pattern.slice(open + 1, close);
  if (body.includes('..')) return null;
  const before = pattern.slice(0, open);
  const after = pattern.slice(close + 1);
  const expanded: string[] = [];
  for (const alternative of topLevelAlternatives(body)) {
    const rest = expandGroups(`${before}${alternative}${after}`);
    if (rest === null) return null;
    expanded.push(...rest);
    if (expanded.length > MAX_BRACE_ALTERNATIVES) return null;
  }
  return expanded;
}

/**
 * Expands the comma lists in braces, nested ones included, the way a glob engine or a shell
 * would. Null when the expansion is not modelled exactly: an unbalanced brace, a body holding
 * `..` (a sequence such as `{a..z}`, which an engine expands to characters the text does not
 * hold), more than 32 brace groups (which bounds the recursion) or more than 64 alternatives.
 */
export function expandBraces(pattern: string): string[] | null {
  if (pattern.split('{').length - 1 > MAX_BRACE_GROUPS) return null;
  return expandGroups(pattern);
}

/** The first balanced `{…}` group in `text`, split into the parts around it; null when none closes. */
function firstGroup(text: string): { before: string; body: string; after: string } | null {
  const open = text.indexOf('{');
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          before: text.slice(0, open),
          body: text.slice(open + 1, index),
          after: text.slice(index + 1),
        };
      }
    }
  }
  return null;
}

/** A `{n..m}` numeric or `{a..z}` letter sequence body, with an optional step. */
const SEQUENCE = /^(?:-?\d+\.\.-?\d+|[A-Za-z]\.\.[A-Za-z])(?:\.\.\d+)?$/;

/** The alternatives of a `{n..m}` or `{a..z}` sequence (with an optional step), the way bash expands it. */
function expandSequence(body: string): string[] | null {
  const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
  const letter = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(\d+))?$/.exec(body);
  const range = (from: number, to: number, step: number, render: (code: number) => string) => {
    const out: string[] = [];
    const by = Math.max(1, Math.abs(step));
    if (from <= to) for (let n = from; n <= to; n += by) out.push(render(n));
    else for (let n = from; n >= to; n -= by) out.push(render(n));
    return out.length > MAX_BRACE_ALTERNATIVES ? null : out;
  };
  if (numeric) {
    return range(Number(numeric[1]), Number(numeric[2]), Number(numeric[3] ?? '1'), String);
  }
  if (letter) {
    return range(
      (letter[1] ?? '').charCodeAt(0),
      (letter[2] ?? '').charCodeAt(0),
      Number(letter[3] ?? '1'),
      (code) => String.fromCharCode(code),
    );
  }
  return null;
}

/**
 * Expands one shell word's brace expressions the way bash does: comma lists (nested and empty
 * alternatives included) and `{n..m}`/`{a..z}` sequences, with its step. A single-element or
 * malformed brace (`{0}`, `{}`, `stash@{0}`) stays literal, as both shells leave it. Null when the
 * expansion runs past the caps, or a literal brace holds a nested brace the function does not model.
 * zsh does not expand every sequence; bash's expansion is the superset, so the guard judges that.
 */
export function expandBraceWord(word: string): string[] | null {
  if (word.split('{').length - 1 > MAX_BRACE_GROUPS) return null;
  const group = firstGroup(word);
  if (group === null) return [word];
  const alternatives = topLevelAlternatives(group.body);
  let pieces: string[];
  if (alternatives.length > 1) {
    pieces = alternatives;
  } else if (SEQUENCE.test(group.body)) {
    // A sequence that runs past the cap is unread, not literal.
    const sequence = expandSequence(group.body);
    if (sequence === null) return null;
    pieces = sequence;
  } else {
    // A single-element or malformed brace is literal; a nested brace in it is not modelled.
    if (group.body.includes('{')) return null;
    const rest = expandBraceWord(group.after);
    return rest === null ? null : rest.map((tail) => `${group.before}{${group.body}}${tail}`);
  }
  const expanded: string[] = [];
  for (const piece of pieces) {
    const rest = expandBraceWord(`${group.before}${piece}${group.after}`);
    if (rest === null) return null;
    expanded.push(...rest);
    if (expanded.length > MAX_BRACE_ALTERNATIVES) return null;
  }
  return expanded;
}
