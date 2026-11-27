import { InboxItemDto, InboxPageDto } from '@10db/contracts';
import { z } from 'zod';

/**
 * An Inbox page as the desktop reads it. A card that does not parse is left out, with its place in every
 * row, and logged, so one bad card cannot empty the whole list; a row left with no card goes too.
 */
export const TolerantInboxPage = InboxPageDto.extend({ items: z.array(z.unknown()) }).transform(
  (page): InboxPageDto => {
    const items: InboxItemDto[] = [];
    for (const raw of page.items) {
      const parsed = InboxItemDto.safeParse(raw);
      if (parsed.success) items.push(parsed.data);
      else console.warn('10db: left out an Inbox card that does not parse', raw, parsed.error);
    }
    const held = new Set<string>(items.map((item) => item.id));
    const rows = page.rows
      .map((row) => ({ ...row, ids: row.ids.filter((id) => held.has(id)) }))
      .filter((row) => row.ids.length > 0);
    return { ...page, items, rows };
  },
);
