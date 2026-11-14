import { isAlias, isMap, isScalar, parseAllDocuments, stringify, visit, type Document } from 'yaml';
import { z } from 'zod';

/** Claude Code's own frontmatter split (2.1.302): an opening `---` line, then up to the first `---`. */
const CLAUDE_CODE_FRONTMATTER = /^---\s*\n([\s\S]*?)---\s*\n?/;
const OPENS_FRONTMATTER = /^---\s*\n/;

/** A definition file split as Claude Code splits it, its frontmatter's keys in their written order. */
export type Frontmatter =
  | {
      /** Null when the file has no frontmatter block. */
      readonly block: string | null;
      readonly pairs: readonly (readonly [string, unknown])[];
      /** Everything after the block, as written. */
      readonly body: string;
    }
  | { readonly refused: string };

function holdsAlias(doc: Document): boolean {
  const seen = { alias: false };
  visit(doc, {
    Alias: () => {
      seen.alias = true;
      return visit.BREAK;
    },
  });
  return seen.alias;
}

function readBlock(block: string): readonly (readonly [string, unknown])[] | { refused: string } {
  const docs = parseAllDocuments(block, { uniqueKeys: true });
  if (!Array.isArray(docs)) return [];
  if (docs.length > 1) return { refused: 'its frontmatter holds more than one document' };
  const doc = docs[0];
  if (doc === undefined) return [];
  if (doc.errors.length > 0) return { refused: 'its frontmatter is not YAML 10db reads' };
  if (holdsAlias(doc)) return { refused: 'its frontmatter uses an alias' };
  if (doc.contents === null) return [];
  if (!isMap(doc.contents)) return { refused: 'its frontmatter is not a table' };
  const values = z.record(z.string(), z.unknown()).safeParse(doc.toJS({ maxAliasCount: 0 }));
  if (!values.success) return { refused: 'its frontmatter is not a table' };
  const pairs: (readonly [string, unknown])[] = [];
  for (const pair of doc.contents.items) {
    const key = pair.key;
    if (isAlias(key) || !isScalar(key) || typeof key.value !== 'string')
      return { refused: 'its frontmatter has a key that is not text' };
    const name = key.value;
    pairs.push([name, Object.hasOwn(values.data, name) ? values.data[name] : undefined]);
  }
  return pairs;
}

/**
 * Splits a definition file as Claude Code does and reads its frontmatter, or says why 10db can't. Any
 * throw from reading YAML someone else wrote (a stack exhausted by nesting) refuses the file.
 */
export function readFrontmatter(text: string): Frontmatter {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const match = CLAUDE_CODE_FRONTMATTER.exec(source);
  if (!match) {
    if (OPENS_FRONTMATTER.test(source)) return { refused: 'its frontmatter has no end' };
    return { block: null, pairs: [], body: source };
  }
  const block = match[1] ?? '';
  let pairs;
  try {
    pairs = readBlock(block);
  } catch {
    return { refused: 'its frontmatter is not YAML 10db reads' };
  }
  if ('refused' in pairs) return pairs;
  return { block, pairs, body: source.slice(match[0].length) };
}

/**
 * A definition file with `values` as its frontmatter, emitted from the values and never edited as text,
 * then `body`; just the body when there are none. It must read back, under Claude Code's own split, as
 * exactly what was emitted.
 */
export function writeFrontmatter(
  values: Readonly<Record<string, unknown>>,
  body: string,
): { text: string } | { refused: string } {
  if (Object.keys(values).length === 0) return { text: body };
  const yaml = stringify(values);
  const out = `---\n${yaml}---\n${body}`;
  const readBack = CLAUDE_CODE_FRONTMATTER.exec(out);
  if (readBack?.[1] !== yaml || out.slice(readBack[0].length) !== body)
    return { refused: 'its frontmatter would not read back as written' };
  return { text: out };
}
