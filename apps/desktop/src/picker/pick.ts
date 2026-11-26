// Pick on Page spec §3: what one picked element carries, from react-grab's primitives. A source path is a
// hint for the agent, never trusted: it is made relative to the project here, and the shell and the UI
// drop any path that still points outside it.

import type { PagePickInput, PickRect } from '@10db/contracts';
import { getElementContext, getElementSelector } from 'react-grab/primitives';

export type { PagePickInput } from '@10db/contracts';
export type PickElementInput = PagePickInput['elements'][number];

/** First segments of a path on the Mac (or a Linux box) rather than in a container's app folder. */
const HOST_ROOTS = new Set([
  'Users',
  'home',
  'private',
  'tmp',
  'var',
  'opt',
  'etc',
  'usr',
  'Volumes',
  'System',
  'Library',
  'Applications',
  'root',
  'nix',
]);

/**
 * A dev server's name for a file, made relative to the project: URL forms and bundler prefixes taken
 * off, the project's own folder taken off, and a container's mount (`/frontend/app/page.tsx`) read as
 * a folder of the project. Null when it still names somewhere else.
 */
export function relativeSource(raw: string, repoPath: string): string | null {
  let file = raw.trim().split(/[?#]/)[0] ?? '';
  file = file
    .replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, '')
    .replace(/^webpack:\/\/[^/]*\//, '')
    .replace(/^file:\/\//, '')
    .replace(/^\[project\]\//, '')
    .replace(/^\.\//, '');
  if (/^[a-z]+:\/\//i.test(file)) {
    const url = URL.parse(file);
    if (url === null) return null;
    file = decodeURIComponent(url.pathname);
  }
  const root = repoPath.replace(/\/+$/, '');
  if (root !== '' && file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  if (file.startsWith('/')) {
    const first = file.split('/')[1] ?? '';
    if (HOST_ROOTS.has(first)) return null;
    file = file.slice(1);
  }
  return file === '' ? null : file;
}

const rectOf = (element: Element): PickRect => {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

const textOf = (element: Element): string => {
  const value = element instanceof HTMLInputElement ? element.value : '';
  return (element.textContent || value).trim().replace(/\s+/g, ' ').slice(0, 200);
};

/** A short name for the element in the hover tag and the chip: its tag and the start of its text. */
export function elementTitle(element: Element): string {
  const text = textOf(element);
  const tag = element.tagName.toLowerCase();
  return text === '' ? tag : `${tag} “${text.length > 28 ? `${text.slice(0, 28)}…` : text}”`;
}

/** The element as a pick names it without its source, for a lookup that took too long. */
export function describeNow(element: Element): PickElementInput {
  return {
    tag: element.tagName.toLowerCase().slice(0, 40),
    selector: safeSelector(element),
    text: textOf(element),
    rect: rectOf(element),
    component: null,
    source: null,
  };
}

/** The element as a pick names it, its source looked up from React's own records. */
export async function describe(element: Element, repoPath: string): Promise<PickElementInput> {
  const base = describeNow(element);
  try {
    const context = await getElementContext(element);
    const file = context.filePath === null ? null : relativeSource(context.filePath, repoPath);
    return {
      ...base,
      component: context.componentName?.slice(0, 120) ?? null,
      source:
        file === null || context.lineNumber === null
          ? null
          : {
              file: file.slice(0, 300),
              line: context.lineNumber,
              ...(context.columnNumber === null ? {} : { column: context.columnNumber }),
            },
    };
  } catch {
    return { ...base, component: null, source: null };
  }
}

function safeSelector(element: Element): string {
  try {
    return getElementSelector(element).slice(0, 500);
  } catch {
    return element.tagName.toLowerCase();
  }
}

/** The element's box now, for a pick whose page has scrolled since. */
export const boxOf = rectOf;
