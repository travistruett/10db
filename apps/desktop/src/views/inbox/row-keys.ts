/** What a key does on a focused row of an Inbox table. */
export const RowKeyAction = {
  Expand: 'expand',
  Collapse: 'collapse',
  Next: 'next',
  Previous: 'previous',
} as const;
export type RowKeyAction = (typeof RowKeyAction)[keyof typeof RowKeyAction];

/**
 * The key's action on a row: Enter opens or closes it, → opens and ← closes it, and ↓ and ↑ move to the
 * next and previous row. Null for a key the row leaves alone.
 */
export function rowKeyAction(key: string, expanded: boolean): RowKeyAction | null {
  switch (key) {
    case 'Enter':
      return expanded ? RowKeyAction.Collapse : RowKeyAction.Expand;
    case 'ArrowRight':
      return expanded ? null : RowKeyAction.Expand;
    case 'ArrowLeft':
      return expanded ? RowKeyAction.Collapse : null;
    case 'ArrowDown':
      return RowKeyAction.Next;
    case 'ArrowUp':
      return RowKeyAction.Previous;
    default:
      return null;
  }
}
