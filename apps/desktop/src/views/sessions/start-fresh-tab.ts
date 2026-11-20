import type { ProjectId } from '@10db/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useOpenChats } from '../../daemon/chat-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { openFreshTab, readFreshTabs, writeFreshTabs } from './fresh-tabs';

/**
 * Writes a fresh tab at the end of the strip, in `selected` when it is among `projects` and else the first
 * project, and answers its id; null when there is no project. Sessions reads it in when its address names it.
 */
export function startFreshTab(
  projects: readonly { readonly id: ProjectId }[],
  selected: ProjectId | null,
  openChats: number,
  plan: boolean,
): string | null {
  const fresh = readFreshTabs();
  const made = openFreshTab(
    fresh,
    projects,
    selected,
    openChats + fresh.length - 1,
    undefined,
    plan,
  );
  if (made === null) return null;
  writeFreshTabs(made.tabs);
  return made.opened.id;
}

/** New Plan from any view: Sessions opens on a fresh tab that creates its session with a plan. */
export function useNewPlan(): () => void {
  const navigate = useNavigate();
  const { projects, project } = useSelectedProject();
  const open = useOpenChats();
  return () => {
    const id = startFreshTab(
      projects.data ?? [],
      project?.id ?? null,
      open.data?.length ?? 0,
      true,
    );
    if (id !== null) void navigate({ to: '/sessions', search: { fresh: id } });
  };
}
