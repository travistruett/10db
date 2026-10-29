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
  if (glob === '**') return { words: 'every file in the project', example: exampleOf(glob) };
  if (glob.startsWith('!')) {
    const rest = describePathPattern(glob.slice(1));
    return { words: `everything except ${rest.words}`, example: rest.example };
  }
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
  if (p.dir.includes('**'))
    return `files matching ${p.last} anywhere under ${p.dir.slice(0, p.dir.indexOf('**')).replace(/\/$/, '')}/`;
  if (p.dir.includes('*') || p.dir.includes('{')) return `paths matching ${p.rest}`;
  if (p.last.includes('*'))
    return p.dir === ''
      ? `files matching ${p.last} at the top of the project`
      : `files matching ${p.last} directly in ${p.dir}/`;
  return p.dir === '' ? `${p.rest} at the top of the project` : `${p.rest} in the project folder`;
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
