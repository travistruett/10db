import { BoardStatus, type ProjectId } from '@10db/contracts';
import { useLocalStorage } from '@mantine/hooks';
import { columnKeyId, type ColumnKey, type LayoutColumn } from './board-layout';

/** The builder can collapse the human columns (Icebox among them) and Done: the ones that grow without bound. */
export function isCollapsible(key: ColumnKey): boolean {
  return key.kind === 'human' || key.status === BoardStatus.Done;
}

/**
 * Whether a column shows as a narrow rail: it is empty, or the builder collapsed it. Ready stays
 * open while empty, because its foot holds Add Task.
 */
export function isRail(column: LayoutColumn, collapsed: readonly string[]): boolean {
  if (column.tasks.length === 0) {
    return !(column.key.kind === 'system' && column.key.status === BoardStatus.Ready);
  }
  return isCollapsible(column.key) && collapsed.includes(columnKeyId(column.key));
}

/** The stored collapse choice: a list of column keys; anything else reads as none collapsed. */
export function parseCollapsed(value: string | undefined): string[] {
  try {
    if (value === undefined) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export interface CollapsedColumns {
  readonly collapsed: readonly string[];
  /** Collapses the column, or opens it again. */
  readonly toggle: (key: ColumnKey) => void;
}

/** The columns the builder collapsed, remembered per project in this browser only. */
export function useCollapsedColumns(projectId: ProjectId): CollapsedColumns {
  const [collapsed, setCollapsed] = useLocalStorage<string[]>({
    key: `tendb.board-collapsed.${projectId}`,
    defaultValue: [],
    getInitialValueInEffect: false,
    deserialize: parseCollapsed,
  });
  return {
    collapsed,
    toggle: (key) => {
      const id = columnKeyId(key);
      setCollapsed((current) =>
        current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
      );
    },
  };
}
