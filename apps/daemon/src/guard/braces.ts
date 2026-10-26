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
