import { VisuallyHidden } from '@mantine/core';
import { useState } from 'react';
import { announcements, type AnnouncedPage } from './announcements';
import { PageStatus } from './page-status';
import type { QueueRow } from './queue-rows';

function announced(rows: readonly QueueRow[]): AnnouncedPage[] {
  return rows.map((row) => ({
    taskId: row.page.taskId,
    area: row.page.area,
    status: row.status,
    line: row.state.line,
  }));
}

/**
 * A key that changes only when a page's status does, or an ask's kind: Ready and working lines tick
 * their minutes, which is never news.
 */
function statusKey(pages: readonly AnnouncedPage[]): string {
  return pages
    .map((page) =>
      [page.taskId, page.status, page.status === PageStatus.Asks ? page.line : ''].join(':'),
    )
    .join('|');
}

/**
 * The Workbench's one polite live region (spec §4.6): it says a page becoming ready, a question and a
 * failure. The pass it opened on is only a baseline, and it never moves focus.
 */
export function Announcer({ rows }: { readonly rows: readonly QueueRow[] }) {
  const now = announced(rows);
  const key = statusKey(now);
  const [seen, setSeen] = useState<{
    readonly key: string;
    readonly pages: AnnouncedPage[];
  } | null>(null);
  const [message, setMessage] = useState('');
  if (seen?.key !== key) {
    setSeen({ key, pages: now });
    if (seen !== null) {
      const said = announcements(seen.pages, now);
      if (said.length > 0) setMessage(said.join('. '));
    }
  }
  return (
    <VisuallyHidden role="status" aria-live="polite" aria-label="UI Workbench announcements">
      {message}
    </VisuallyHidden>
  );
}
