const MAX_BRACE_GROUPS = 32;
const MAX_BRACE_ALTERNATIVES = 64;
/** A lone `{n..m}` or `{a..z}` sequence, with no other brace group in the word, may run this long. */
const MAX_SEQUENCE_ALTERNATIVES = 4096;

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

/**
 * The alternatives of a `{n..m}` or `{a..z}` sequence (with an optional step), the way bash expands
 * it. The count is computed before anything is allocated, so a sequence past `cap` costs nothing;
 * it is null then, and when an end is not a safe integer.
 */
function expandSequence(body: string, cap: number): string[] | null {
  const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
  const letter = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(\d+))?$/.exec(body);
  const range = (
    from: number,
    to: number,
    step: number,
    render: (code: number) => string,
  ): string[] | null => {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isSafeInteger(step))
      return null;
    const by = Math.max(1, Math.abs(step));
    const count = Math.floor(Math.abs(to - from) / by) + 1;
    if (count > cap) return null;
    const direction = from <= to ? 1 : -1;
    return Array.from({ length: count }, (_, index) => render(from + direction * index * by));
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
 * Stand-ins for the brace-syntax characters a word holds quoted or escaped. The shell passes them
 * as literal text, so the expansion must read past them; they are put back in every result.
 */
const STAND_INS: ReadonlyMap<string, string> = new Map([
  ['{', ''],
  ['}', ''],
  [',', ''],
  ['.', ''],
]);
const LITERALS: ReadonlyMap<string, string> = new Map(
  [...STAND_INS].map(([literal, standIn]) => [standIn, literal]),
);
const HOLDS_STAND_IN = /[-]/;
const restoreLiterals = (text: string): string =>
  text.replace(/[-]/g, (standIn) => LITERALS.get(standIn) ?? standIn);

function expandMarked(word: string, loneSequence: boolean): string[] | null {
  const group = firstGroup(word);
  if (group === null) return [word];
  const alternatives = topLevelAlternatives(group.body);
  let pieces: string[];
  if (alternatives.length > 1) {
    pieces = alternatives;
  } else if (SEQUENCE.test(group.body)) {
    // A sequence that runs past its cap is unread, not literal.
    const sequence = expandSequence(
      group.body,
      loneSequence ? MAX_SEQUENCE_ALTERNATIVES : MAX_BRACE_ALTERNATIVES,
    );
    if (sequence === null) return null;
    // A sequence that yields an option word (`{-5..-1}`) is unread: rm would take it as a flag.
    if (sequence.some((piece) => `${group.before}${piece}`.startsWith('-'))) return null;
    pieces = sequence;
  } else {
    // zsh reads a sequence whose dots are quoted (`{1'..'3}`) while bash keeps it literal.
    if (SEQUENCE.test(restoreLiterals(group.body))) return null;
    // A single-element or malformed brace is literal; a nested brace in it is not modelled.
    if (group.body.includes('{')) return null;
    const rest = expandMarked(group.after, loneSequence);
    return rest === null ? null : rest.map((tail) => `${group.before}{${group.body}}${tail}`);
  }
  const cap = loneSequence ? MAX_SEQUENCE_ALTERNATIVES : MAX_BRACE_ALTERNATIVES;
  const expanded: string[] = [];
  for (const piece of pieces) {
    const rest = expandMarked(`${group.before}${piece}${group.after}`, loneSequence);
    if (rest === null) return null;
    expanded.push(...rest);
    if (expanded.length > cap) return null;
  }
  return expanded;
}

/**
 * Expands one shell word's brace expressions the way bash does: comma lists (nested and empty
 * alternatives included) and `{n..m}`/`{a..z}` sequences, with its step. `mask` is the word with
 * every quoted or escaped character blanked to NUL: a brace, comma or dot blanked there is literal
 * text, never brace syntax, as the shell reads it. A single-element or malformed brace (`{0}`,
 * `{}`, `stash@{0}`) stays literal, as both shells leave it. Null when the expansion runs past the
 * caps (64 alternatives, or 4096 for a lone sequence with no other brace group in the word), a
 * sequence yields a word starting with `-`, or a literal brace holds a nested brace the function
 * does not model. zsh does not expand every sequence; bash's expansion is the superset, so the
 * guard judges that.
 */
export function expandBraceWord(word: string, mask: string = word): string[] | null {
  // A word that already holds a stand-in cannot be told apart from its quoted form.
  if (HOLDS_STAND_IN.test(word)) return null;
  const marked = Array.from(word, (ch, at) =>
    mask.charAt(at) === ch ? ch : (STAND_INS.get(ch) ?? ch),
  ).join('');
  const groups = marked.split('{').length - 1;
  if (groups > MAX_BRACE_GROUPS) return null;
  const loneSequence = groups === 1 && SEQUENCE.test(firstGroup(marked)?.body ?? '');
  const expanded = expandMarked(marked, loneSequence);
  return expanded === null ? null : expanded.map(restoreLiterals);
}
