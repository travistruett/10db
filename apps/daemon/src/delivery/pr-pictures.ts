import { ScreenKind, type TaskScreenDto } from '@10db/contracts';

// Decision 2026-11-12-a-pass-pull-request-can-show-before-and-after-pictures: with the project's
// setting on, a pass's pull request shows each signed-off page's first before and last after, side by
// side, from a commit of those files alone on a `10db-pictures/<pass>` branch of origin.

/** One picture on the pictures branch: its file name there and the row it comes from. */
export interface PlannedPicture {
  readonly name: string;
  readonly screen: TaskScreenDto;
}

/** One route of a signed-off page, with its before and after; at least one is there. */
export interface PagePicturePair {
  readonly title: string;
  readonly route: string;
  readonly before: PlannedPicture | null;
  readonly after: PlannedPicture | null;
}

export interface PageScreens {
  readonly title: string;
  /** The page's pictures, oldest first. */
  readonly screens: readonly TaskScreenDto[];
}

/** A route as a file name's word: `/settings/[id]` is `settings-id`, `/` is `home`. */
function routeWord(route: string): string {
  const word = route
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return word === '' ? 'home' : word;
}

/**
 * The pictures each page's pull request shows: per route, in the viewport and theme the route was first
 * pictured in, its first before and its last after. Turn pictures are left out.
 */
export function picturePlan(pages: readonly PageScreens[]): PagePicturePair[] {
  return pages.flatMap((page, index) => {
    const routes = [...new Set(page.screens.map((s) => s.route))];
    return routes.flatMap((route) => {
      const first = page.screens.find((s) => s.route === route);
      if (first === undefined) return [];
      const same = page.screens.filter(
        (s) =>
          s.route === route &&
          s.viewport.width === first.viewport.width &&
          s.viewport.height === first.viewport.height &&
          s.theme === first.theme,
      );
      const name = (kind: string) => `${String(index + 1)}-${routeWord(route)}-${kind}.png`;
      const before = same.find((s) => s.kind === ScreenKind.Before);
      const after = same.findLast((s) => s.kind === ScreenKind.After);
      if (before === undefined && after === undefined) return [];
      return [
        {
          title: page.title,
          route,
          before: before === undefined ? null : { name: name('before'), screen: before },
          after: after === undefined ? null : { name: name('after'), screen: after },
        },
      ];
    });
  });
}

/** The pull request's Pictures section, its images at `sha` on `repo`; empty with no pictures. */
export function picturesSection(
  repo: string,
  sha: string,
  plan: readonly PagePicturePair[],
): string {
  if (plan.length === 0) return '';
  const cell = (picture: PlannedPicture | null, kind: 'Before' | 'After'): string =>
    picture === null
      ? `No ${kind.toLowerCase()} picture`
      : `![${kind}](https://github.com/${repo}/blob/${sha}/${picture.name}?raw=true)`;
  const pages = plan.map((pair) =>
    [
      `**${pair.title}** \`${pair.route}\``,
      '',
      '| Before | After |',
      '| --- | --- |',
      `| ${cell(pair.before, 'Before')} | ${cell(pair.after, 'After')} |`,
    ].join('\n'),
  );
  return ['## Pictures', '', pages.join('\n\n')].join('\n');
}
