export interface PathPatternText {
  /** The pattern in plain words, as a folder pattern. */
  readonly words: string;
  /** A path the pattern matches. */
  readonly example: string;
}

const INSIDE = '/**';
const ANYWHERE = '**/';

/** Explains a path pattern (a glob relative to the project folder) in words, with a path it matches. */
export function describePathPattern(glob: string): PathPatternText {
  const inside = glob.endsWith(INSIDE);
  const withoutInside = inside ? glob.slice(0, -INSIDE.length) : glob;
  const anywhere = withoutInside.startsWith(ANYWHERE);
  const rest = anywhere ? withoutInside.slice(ANYWHERE.length) : withoutInside;
  const slash = rest.lastIndexOf('/');
  const last = rest.slice(slash + 1);
  const dir = slash === -1 ? '' : rest.slice(0, slash);
  return { words: words({ inside, anywhere, rest, last, dir }), example: exampleOf(glob) };
}

function words(p: {
  inside: boolean;
  anywhere: boolean;
  rest: string;
  last: string;
  dir: string;
}): string {
  if (p.inside && p.anywhere) return `${p.rest}/ in any folder, and everything inside it`;
  if (p.inside) return `${p.rest}/ and everything inside it`;
  if (p.anywhere) return `${p.rest} in any folder`;
  if (p.last.includes('*'))
    return p.dir === ''
      ? `files matching ${p.last} at the top of the project`
      : `files matching ${p.last} directly in ${p.dir}/`;
  return `${p.rest} at the top of the project`;
}

function exampleOf(glob: string): string {
  const withInside = glob.endsWith(INSIDE) ? `${glob.slice(0, -INSIDE.length)}/folder/file` : glob;
  return withInside
    .replaceAll(ANYWHERE, 'folder/')
    .replaceAll('**', 'folder')
    .replace(/\{([^,}]*)[^}]*\}/g, '$1')
    .replace(/\[!?(.)[^\]]*\]/g, '$1')
    .replaceAll('*', 'file')
    .replaceAll('?', 'a');
}
