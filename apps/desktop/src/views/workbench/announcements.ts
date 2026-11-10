import { PageStatus } from './page-status';

// Workbench spec §4.6, design review D16: the Workbench changes on its own, so it says out loud only what
// the builder acts on: a page becoming ready, a question and a failure. Nothing else is announced.

/** A page as the announcer compares it with how it was. */
export interface AnnouncedPage {
  readonly taskId: string;
  readonly area: string;
  readonly status: PageStatus;
  /** The page's state line; for a page that asks, whether it is a question or a permission. */
  readonly line: string;
}

const SAID: Partial<Record<PageStatus, (page: AnnouncedPage) => string>> = {
  [PageStatus.Ready]: (page) => `${page.area} is ready`,
  [PageStatus.Asks]: (page) =>
    `${page.area} ${page.line.charAt(0).toLowerCase()}${page.line.slice(1)}`,
  [PageStatus.Failed]: (page) => `${page.area} failed`,
};

/** What to say for the pages `now` that came into a ready, asking or failed state since `before`. */
export function announcements(
  before: readonly AnnouncedPage[],
  now: readonly AnnouncedPage[],
): string[] {
  const was = new Map(before.map((page) => [page.taskId, page.status]));
  return now.flatMap((page) => {
    const say = SAID[page.status];
    return say === undefined || was.get(page.taskId) === page.status ? [] : [say(page)];
  });
}
