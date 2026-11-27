/**
 * Finds the card builders in a source file: each object literal that sets `tier` to an ask or a status
 * (`CardTier.Ask`, `CardTier.Status`, also inside a conditional). A notice sets `CardTier.Notice` and is no card.
 */
const TIER = /\btier:[^,\n}]*\bCardTier\.(?:Ask|Status)\b/g;

export interface CardBuilder {
  /** 1-based line of the `tier:` property. */
  readonly line: number;
  /** The names of the literal's own properties (not those of objects inside it). */
  readonly properties: readonly string[];
}

/** Where the object literal around `at` opens, or -1 when `at` is in no literal. */
function literalStart(src: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** The text of the literal opening at `start` that sits directly in it: nested braces, strings and comments cut out. */
function ownText(src: string, start: number): string {
  let depth = 0;
  let own = '';
  for (let i = start; i < src.length; i++) {
    const ch = src[i] ?? '';
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i === -1) break;
      i++;
      continue;
    }
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) own += ch;
  }
  return own;
}

const PROPERTY_NAME = /(?:^|[,\s])(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[:,]/g;

export function cardBuilders(src: string): CardBuilder[] {
  const found: CardBuilder[] = [];
  for (const match of src.matchAll(TIER)) {
    const at = match.index;
    const start = literalStart(src, at);
    if (start === -1) continue;
    const own = ownText(src, start);
    const properties = [...own.matchAll(PROPERTY_NAME)].flatMap((m) => (m[1] ? [m[1]] : []));
    found.push({ line: src.slice(0, at).split('\n').length, properties });
  }
  return found;
}

/** The card builders in `src` that declare no `decision`. */
export function undeclaredBuilders(src: string): CardBuilder[] {
  return cardBuilders(src).filter((builder) => !builder.properties.includes('decision'));
}
