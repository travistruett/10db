/**
 * The row selected after the list changed: the stored key while it is still there, else the row now
 * at the old index (the next one, or the last when the end went), else none.
 */
export function nextSelection(
  keys: readonly string[],
  selected: string | null,
  lastIndex: number,
): { readonly key: string | null; readonly index: number } {
  if (selected !== null) {
    const at = keys.indexOf(selected);
    if (at !== -1) return { key: selected, index: at };
  }
  const index = Math.max(0, Math.min(lastIndex, keys.length - 1));
  const key = keys[index];
  return key === undefined ? { key: null, index: 0 } : { key, index };
}
