/**
 * The craft skills one step loads: its persona's, then each of the task's kinds', each named once, in
 * that order. A persona-less step takes only the kinds'.
 */
export function stepSkills(
  persona: { readonly skills: readonly string[] } | null,
  kinds: readonly { readonly skills: readonly string[] }[],
): string[] {
  return [...new Set([...(persona?.skills ?? []), ...kinds.flatMap((kind) => kind.skills)])];
}
