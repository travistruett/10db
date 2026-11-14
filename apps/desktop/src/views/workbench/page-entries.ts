import type {
  ConversationFileDto,
  ConversationItemDto,
  NoticeOffer,
  PassTurnId,
  PassTurnWithFilesDto,
} from '@10db/contracts';
import type { ReactNode } from 'react';
import type { ConversationEntry } from '../../conversation';
import { itemEntry, liveEntries } from '../../conversation/item-entries';
import type { LiveItems } from '../../conversation/live-items';

// Workbench spec §4.3, sessions UI spec §7.3 (before M9): a page's thread as the kit's entries. The
// builder's messages carry their pictures, a notice its Send to Agent or Allow This, and each ended
// turn's last reply is followed by the files and pictures that turn left; the rest is the kit's.

/** How the page draws the rows that are its own, each keyed by the entry it follows. */
export interface PageRows {
  /** Where the page is and the pictures it opened with, at the top. */
  readonly opening: () => ReactNode;
  readonly pictures: (files: readonly ConversationFileDto[]) => ReactNode;
  readonly notice: (id: string, text: string, offer: NoticeOffer | null) => ReactNode;
  /** The files a turn changed and the pictures taken after it. */
  readonly turn: (turn: PassTurnWithFilesDto) => ReactNode;
}

/** Each turn's last agent item, by its id, which the turn's files and pictures follow. */
function lastOfTurns(items: readonly ConversationItemDto[]): ReadonlyMap<string, PassTurnId> {
  const last = new Map<PassTurnId, string>();
  for (const item of items)
    if (item.author === 'agent' && item.turnId !== undefined) last.set(item.turnId, item.id);
  return new Map([...last].map(([turn, id]) => [id, turn]));
}

/** The page's entries: its opening, its stored items in `seq` order, then what streams. */
export function pageEntries(
  items: readonly ConversationItemDto[],
  live: LiveItems,
  turns: readonly PassTurnWithFilesDto[],
  rows: PageRows,
): readonly ConversationEntry[] {
  const ended = new Map(turns.filter((t) => t.endedAt !== null).map((t) => [t.id, t]));
  const turnAfter = lastOfTurns(items);
  const out: ConversationEntry[] = [{ kind: 'custom', id: 'opening', render: rows.opening }];
  for (const item of items) {
    if (item.kind === 'message' && item.author === 'builder') {
      const files = item.files ?? [];
      out.push({
        kind: 'builder',
        id: item.id,
        text: item.text,
        extra: files.length === 0 ? null : rows.pictures(files),
      });
    } else if (item.kind === 'notice') {
      // A notice is 10db's, drawn with its code spans and what it offers to send.
      const offer = item.offer ?? null;
      out.push({
        kind: 'custom',
        id: item.id,
        render: () => rows.notice(item.id, item.text, offer),
      });
    } else {
      const entry = itemEntry(item, {
        sendNow: () => undefined,
        label: 'Agent',
        receipts: false,
        working: false,
        cards: [],
      });
      if (entry !== null) out.push(entry);
    }
    const turnId = turnAfter.get(item.id);
    const turn = turnId === undefined ? undefined : ended.get(turnId);
    if (turn !== undefined)
      out.push({ kind: 'custom', id: `turn-${turn.id}`, render: () => rows.turn(turn) });
  }
  return [...out, ...liveEntries(live, new Set(items.map((item) => item.id)))];
}
