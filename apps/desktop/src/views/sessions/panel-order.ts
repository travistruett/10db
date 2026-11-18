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
