import type { ConversationEntry, ToolEntry } from './entry';

// How entries become rows: consecutive reads and searches fold into one row, as do consecutive
// edits, and a subagent's calls sit under it, a nested subagent's calls under the outermost one. A
// call whose parent isn't in the list stays at the top level, so nothing is dropped.

export type ConversationRow =
  | { readonly kind: 'entry'; readonly entry: ConversationEntry }
  | { readonly kind: 'tool'; readonly entry: ToolEntry; readonly nested: readonly ToolEntry[] }
  | { readonly kind: 'tool_group'; readonly id: string; readonly entries: readonly ToolEntry[] }
  | { readonly kind: 'edit_group'; readonly id: string; readonly entries: readonly ToolEntry[] };

type Fold = 'tool_group' | 'edit_group';

function foldOf(entry: ToolEntry): Fold | null {
  switch (entry.call.kind) {
    case 'read':
    case 'search':
      return 'tool_group';
    case 'edit':
      return 'edit_group';
    case 'command':
    case 'mcp':
    case 'subagent':
    case 'web':
    case 'other':
      return null;
  }
}

/** The rows `entries` draw as, in order. */
export function conversationRows(
  entries: readonly ConversationEntry[],
): readonly ConversationRow[] {
  const parentOf = new Map(
    entries.flatMap((e) =>
      e.kind === 'tool' && e.call.kind === 'subagent' ? [[e.id, e.call.parentId] as const] : [],
    ),
  );
  /** The top-level subagent `id` sits under, following parents; a cycle stops at its first repeat. */
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let root = id;
    for (let up = parentOf.get(root); up != null && parentOf.has(up) && !seen.has(up);) {
      seen.add(root);
      root = up;
      up = parentOf.get(root);
    }
    return root;
  };
  const nested = new Map<string, ToolEntry[]>();
  const top: ConversationEntry[] = [];
  for (const entry of entries) {
    const parent = entry.kind === 'tool' ? entry.call.parentId : null;
    const root = parent !== null && parentOf.has(parent) ? rootOf(parent) : null;
    if (entry.kind === 'tool' && root !== null && root !== entry.id) {
      const children = nested.get(root) ?? [];
      children.push(entry);
      nested.set(root, children);
    } else top.push(entry);
  }

  const rows: ConversationRow[] = [];
  /** The run of foldable calls not yet closed into a row. */
  const open: { fold: Fold | null; entries: ToolEntry[] } = { fold: null, entries: [] };
  const close = () => {
    const [first] = open.entries;
    if (open.fold !== null && first !== undefined)
      rows.push(
        open.entries.length === 1
          ? { kind: 'tool', entry: first, nested: [] }
          : { kind: open.fold, id: first.id, entries: open.entries },
      );
    open.fold = null;
    open.entries = [];
  };
  for (const entry of top) {
    const fold = entry.kind === 'tool' ? foldOf(entry) : null;
    if (entry.kind === 'tool' && fold !== null) {
      if (open.fold !== fold) close();
      open.fold = fold;
      open.entries.push(entry);
      continue;
    }
    close();
    rows.push(
      entry.kind === 'tool'
        ? { kind: 'tool', entry, nested: nested.get(entry.id) ?? [] }
        : { kind: 'entry', entry },
    );
  }
  close();
  return rows;
}
