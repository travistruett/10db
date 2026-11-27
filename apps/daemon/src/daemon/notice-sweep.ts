import { listOpenFlagRows, type DbReader, type OpenFlagRow } from '@10db/db';
import type { InboxService } from '../inbox';

/** The reason a swept card carries in its resolution. */
export const NOTICE_SWEEP_REASON = 'This kind of card is a notice now; it is in Activity.';

const startsWith = (prefix: string) => (card: OpenFlagRow) =>
  card.foldKey?.startsWith(prefix) === true;
const noKeyTitled = (title: RegExp | string) => (card: OpenFlagRow) =>
  card.foldKey === null &&
  (typeof title === 'string' ? card.title === title : title.test(card.title));

/**
 * Every kind of card that became a notice, with what its open cards looked like when they were
 * cards. A fold key prefix alone is not enough where the same prefix also names an ask, so those
 * add the title, body or option count that tells them apart. The prefixes are the raisers' own
 * fold keys: `delivery/cards.ts`, `pass/*.ts`, `inbox/` and `mcp/` for the rest.
 */
const NOTICE_TYPES = [
  { name: 'branch-deleted', matches: startsWith('branch-deleted:') },
  {
    name: 'orphan-not-removed',
    matches: (c: OpenFlagRow) =>
      startsWith('worktree-remove-failed:')(c) && c.title.startsWith('10db removed nothing at '),
  },
  {
    name: 'tasks-moved',
    matches: noKeyTitled(/^\d+ tasks? moved off .+, which no longer exists$/),
  },
  {
    name: 'regenerate-failed',
    matches: (c: OpenFlagRow) =>
      startsWith('base-regenerate:')(c) &&
      c.title.includes(": 10db couldn't regenerate files after merging "),
  },
  { name: 'pass-follow-on', matches: startsWith('pass-follow-on:') },
  { name: 'pass-gate', matches: startsWith('pass-gate:') },
  { name: 'pass-branch-moved', matches: startsWith('pass-branch-moved:') },
  {
    name: 'pass-abandoned',
    matches: (c: OpenFlagRow) => startsWith('pass-abandon:')(c) && c.optionCount === 0,
  },
  {
    name: 'model-retried',
    matches: (c: OpenFlagRow) =>
      startsWith('model-refused:')(c) && /, and is running the step on [^ ]+\.$/.test(c.body),
  },
  { name: 'left-changes', matches: noKeyTitled(/^The .+ step left changes in its claims$/) },
  { name: 'no-handoff', matches: noKeyTitled('Session ended without the requested handoff') },
  { name: 'resized', matches: startsWith('resize:') },
  { name: 'pass-did-not-open', matches: noKeyTitled(/^Pass ‘.+’ did not open$/) },
  {
    name: 'pass-cancelled',
    matches: noKeyTitled(/^Pass ‘.+’ was cancelled for 10db’s update$/),
  },
  { name: 'hand-made-removed', matches: startsWith('hand-made-removed:') },
  { name: 'hand-made-spotlight-done', matches: startsWith('hand-made-spotlight-done:') },
  { name: 'flaky-check', matches: startsWith('flaky-check:') },
] as const;

/** The notice type an open card is a leftover of, or null when it is an ask or a status. */
export function noticeTypeOf(card: OpenFlagRow): string | null {
  return NOTICE_TYPES.find((type) => type.matches(card))?.name ?? null;
}

/**
 * Closes every open card of a kind that is a notice now, once at start. Each close is its own
 * write, so a sweep a restart cut short goes on at the next start; a card that closed meanwhile
 * is left as it is. Returns how many it closed.
 */
export function resolveNoticeCards(db: DbReader, inbox: Pick<InboxService, 'resolve'>): number {
  let closed = 0;
  for (const card of listOpenFlagRows(db)) {
    if (noticeTypeOf(card) === null) continue;
    inbox.resolve(card.id, NOTICE_SWEEP_REASON);
    closed += 1;
  }
  return closed;
}
