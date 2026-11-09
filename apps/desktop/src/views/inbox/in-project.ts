import type { ProjectId } from '@10db/contracts';

/** The cards of one project, or every card when no project is chosen. */
export function inProject<T extends { readonly projectId: ProjectId }>(
  items: readonly T[],
  project: ProjectId | undefined,
): T[] {
  return project === undefined ? [...items] : items.filter((item) => item.projectId === project);
}
