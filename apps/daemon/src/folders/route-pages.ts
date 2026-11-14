import { posix } from 'node:path';
import { isPageFile, type FileRouteApp } from './area-candidates';

// Workbench setup: which page files of a framework app are screens of their own beyond its route
// folders, and which screens are none.

/** Marks JSX a page renders: a closing tag, a self-closing tag or a fragment. Never a type's `<…>`. */
const RENDERS = /<\/[A-Za-z]|\/>|<>/u;
const REDIRECTS = /\b(?:permanentRedirect|redirect)\s*\(/u;

/** Whether a page file only sends the browser elsewhere: it calls `redirect(` and renders nothing. */
export function isRedirectOnly(text: string): boolean {
  return REDIRECTS.test(text) && !RENDERS.test(text);
}

/**
 * The index pages of an app with route groups: the `page.*` directly in its route folder, in each
 * route group and in each folder a group passes through to its screens, with the path each shows
 * (`/` for a top group's), groups left out of it. They are no screen folder's.
 */
export function indexPageFiles(
  files: readonly string[],
  app: FileRouteApp,
): { file: string; route: string }[] {
  const folders = app.layoutFolders.filter(
    (f) => f === app.routes || f.startsWith(`${app.routes}/`),
  );
  return files.flatMap((file) => {
    const folder = posix.dirname(file) === '.' ? '' : posix.dirname(file);
    if (!isPageFile(file) || !folders.includes(folder)) return [];
    const names = folder
      .slice(app.routes.length + 1)
      .split('/')
      .filter((name) => name !== '' && !/^\(.+\)$/u.test(name));
    return [{ file, route: `/${names.join('/')}` }];
  });
}
