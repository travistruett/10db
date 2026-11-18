import type { ChatDto, ProjectId } from '@10db/contracts';
import { draftKey } from './session-drafts';
import type { FreshTab } from './fresh-tabs';

/** One row of the panel: a session, or a fresh tab that is not a session until its first message. */
export type PanelRow =
  | { readonly kind: 'chat'; readonly key: string; readonly chat: ChatDto }
  | { readonly kind: 'fresh'; readonly key: string; readonly tab: FreshTab };

export interface PanelGroup {
  readonly projectId: ProjectId;
  readonly rows: readonly PanelRow[];
}

export function panelRowProject(row: PanelRow): ProjectId {
  return row.kind === 'chat' ? row.chat.projectId : row.tab.projectId;
}

/**
 * The panel's groups: projects in the project list's order (the selected one is never moved, so ⌘1-9 stay
 * put), and within one the fresh rows first, then sessions by their place. A project that is gone from the
 * list but still has sessions follows the listed ones.
 */
export function panelGroups(
  projects: readonly { readonly id: ProjectId }[],
  chats: readonly ChatDto[],
  fresh: readonly FreshTab[],
): readonly PanelGroup[] {
  const known = new Set(projects.map((p) => p.id));
  const orphans = [...chats.map((c) => c.projectId), ...fresh.map((t) => t.projectId)].filter(
    (id, i, all) => !known.has(id) && all.indexOf(id) === i,
  );
  const ids = [...projects.map((p) => p.id), ...orphans];
  return ids.flatMap((projectId): PanelGroup[] => {
    const rows: PanelRow[] = [
      ...fresh
        .filter((t) => t.projectId === projectId)
        .sort((a, b) => a.position - b.position)
        .map((tab): PanelRow => ({ kind: 'fresh', key: draftKey.fresh(tab.id), tab })),
      ...chats
        .filter((c) => c.projectId === projectId)
        .sort((a, b) => (a.tabPosition ?? 0) - (b.tabPosition ?? 0))
        .map((chat): PanelRow => ({ kind: 'chat', key: draftKey.chat(chat.id), chat })),
    ];
    return rows.length === 0 ? [] : [{ projectId, rows }];
  });
}

/** Every row in the order the keys walk: ⌘1-9, ⌘⇧[ ], ⌃Tab and ⌘J. */
export function panelOrder(groups: readonly PanelGroup[]): readonly PanelRow[] {
  return groups.flatMap((g) => g.rows);
}

/**
 * Where a new session goes in the open sessions: the top of its project, which is the place of that
 * project's first open session, or the end when it has none. The daemon moves the ones at or after it right.
 */
export function topPosition(chats: readonly ChatDto[], projectId: ProjectId): number {
  const places = chats
    .filter((c) => c.projectId === projectId && c.tabPosition !== null)
    .map((c) => c.tabPosition ?? 0);
  return places.length === 0 ? chats.length : Math.min(...places);
}

/**
 * What dropping the row `active` on the row `over` asks of the daemon: the dragged session takes the
 * dropped-on one's place. A row moves within its project only, since the panel groups by project, so
 * another project's place is not one it can take; a fresh row has no place to take or give.
 */
export function dropTarget(
  rows: readonly PanelRow[],
  active: string,
  over: string,
): { readonly chat: ChatDto; readonly position: number } | null {
  if (active === over) return null;
  const moved = rows.find((r) => r.key === active);
  const target = rows.find((r) => r.key === over);
  if (moved?.kind !== 'chat' || target?.kind !== 'chat') return null;
  if (moved.chat.projectId !== target.chat.projectId) return null;
  return { chat: moved.chat, position: target.chat.tabPosition ?? 0 };
}
