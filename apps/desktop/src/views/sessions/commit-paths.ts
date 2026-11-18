/**
 * The files Commit starts with: the changed files the session touched, checked, and the rest listed
 * unchecked. A file the session touched that git does not list as changed is dropped, and with no touched
 * file in common nothing is checked, so the builder picks.
 */
export function commitFiles(
  changed: readonly string[],
  touched: readonly string[],
): { readonly files: readonly string[]; readonly checked: readonly string[] } {
  const touchedSet = new Set(touched);
  const files = [...new Set(changed)].sort((a, b) => a.localeCompare(b));
  return { files, checked: files.filter((path) => touchedSet.has(path)) };
}
