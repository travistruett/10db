import { z } from 'zod';
import { CARD_RESOLUTION, CardResolution } from './card-resolution';
import { InboxItemDto } from './entities';
import { InboxItemId, PersonId, ProjectId } from './ids';
import { SortDirection } from './knowledge-api';
import { InboxRowRef, InboxRowSort } from './inbox-rows';
import { InboxKind } from './states';

/**
 * Which list of cards `GET /inbox/page` answers. `open` is every open card; `waiting` is an open card
 * whose live send went out and has not come back (state `sent`, no `returnedAt`); `resolved` is a
 * card that was answered, dismissed or closed by 10db.
 */
export const InboxListState = {
  Open: 'open',
  Waiting: 'waiting',
  Resolved: 'resolved',
} as const;
export type InboxListState = (typeof InboxListState)[keyof typeof InboxListState];

/** How a resolved card was closed: a stakeholder's Slack answer, 10db's own close, or the builder's answer. */
export const InboxOutcome = {
  Slack: 'slack',
  TenDb: '10db',
  Answered: 'answered',
} as const;
export type InboxOutcome = (typeof InboxOutcome)[keyof typeof InboxOutcome];

/**
 * A resolved card's outcome, in the order the Resolved view draws it: a Slack answer first, then 10db's
 * reason, and otherwise the builder's answer or dismissal. The page query's outcome filter mirrors this.
 */
export function inboxOutcome(item: Pick<InboxItemDto, 'answer' | 'detail'>): InboxOutcome {
  if (item.answer?.via === 'slack') return InboxOutcome.Slack;
  // The detail is stored JSON: parse it, as the view does.
  if (CardResolution.safeParse(item.detail?.[CARD_RESOLUTION]).success) return InboxOutcome.TenDb;
  return InboxOutcome.Answered;
}

/**
 * What a page of cards can be sorted by. `sentAt` is when the live send went out, for Waiting; a card
 * with no send sorts last.
 */
export const InboxSort = {
  UpdatedAt: 'updatedAt',
  CreatedAt: 'createdAt',
  Kind: 'kind',
  Title: 'title',
  SentAt: 'sentAt',
} as const;
export type InboxSort = (typeof InboxSort)[keyof typeof InboxSort];

export const INBOX_PAGE_SIZE = 25;
export const INBOX_PAGE_SIZE_MAX = 100;

/**
 * The query string of `GET /inbox/page`. With no `sort`, Resolved is newest first, Waiting the longest
 * out first, and Open the most urgent and then oldest first. `person` keeps the cards whose live send
 * went to that person. A page past the last is answered with the last.
 */
export const InboxPageQuery = z
  .strictObject({
    state: z.enum(InboxListState),
    project: ProjectId.optional(),
    kind: z.enum(InboxKind).optional(),
    outcome: z.enum(InboxOutcome).optional(),
    person: PersonId.optional(),
    sort: z.enum(InboxSort).optional(),
    dir: z.enum(SortDirection).optional(),
    /** 1 when absent. */
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(INBOX_PAGE_SIZE_MAX).default(INBOX_PAGE_SIZE),
    /** The last row's sort, as JSON: the page after it. */
    after: z
      .string()
      .transform((text, ctx): InboxRowSort => {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          ctx.addIssue({ code: 'custom', message: 'after is not JSON' });
          return z.NEVER;
        }
        const sort = InboxRowSort.safeParse(json);
        if (!sort.success) {
          ctx.addIssue({ code: 'custom', message: 'after is not a row sort' });
          return z.NEVER;
        }
        return sort.data;
      })
      .optional(),
    /** Title or body contains this, ASCII case folded. */
    q: z.string().trim().min(1).max(200).optional(),
    /** Resolved only: updated at or after. */
    since: z.iso.datetime().optional(),
    /** The page holds only this card's row, when it is in the list. */
    card: InboxItemId.optional(),
  })
  .superRefine((q, ctx) => {
    const refuse = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (q.after !== undefined) {
      if (q.page !== undefined) refuse('after and page cannot be combined');
      if (q.sort !== undefined) refuse('after and sort cannot be combined');
      if (q.dir !== undefined) refuse('after and dir cannot be combined');
    }
    if (q.card !== undefined && q.after !== undefined) refuse('card and after cannot be combined');
    if (q.card !== undefined && q.page !== undefined) refuse('card and page cannot be combined');
    if (q.since !== undefined && q.state !== InboxListState.Resolved)
      refuse('since applies to resolved only');
  });
export type InboxPageQuery = z.output<typeof InboxPageQuery>;

export const InboxPageDto = z.object({
  /** The rows' cards, in order. */
  items: z.array(InboxItemDto),
  /** Every card the filters match, not just this page; Open counts rows with a card triage has placed. */
  total: z.int().min(0),
  /** The page answered, which is the last one when the page asked for is past it; 1 for a keyset or card answer. */
  page: z.int().min(1),
  /** Rows per page. */
  pageSize: z.int().min(1),
  /** One per card in the list, in order. */
  rows: z.array(InboxRowRef).default([]),
  /** `after` for the next page; null on the last. */
  next: InboxRowSort.nullable().default(null),
});
export type InboxPageDto = z.infer<typeof InboxPageDto>;
