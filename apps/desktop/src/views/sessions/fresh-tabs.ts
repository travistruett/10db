import { Effort, ProjectId } from '@10db/contracts';
import { z } from 'zod';

// A fresh tab lives in the client until its first `@` or its first send, and is
// kept in `localStorage` as a per-window convenience. These are pure functions over the list; the
// storage read and write are the only effects, each in try/catch.

export const FRESH_TABS_KEY = 'tendb.sessions.fresh';

export const FreshTab = z.object({
  id: z.string().min(1),
  projectId: ProjectId,
  model: z.string().min(1).nullable(),
  /** A tab kept before efforts existed has none, which runs the model's own. */
  effort: z.enum(Effort).nullable().default(null),
  /** Where the tab sits in the strip, which the chat made from it takes. */
  position: z.int().nonnegative(),
  /** The Plan toggle is on: the session this tab becomes starts with its Plan. */
  plan: z.boolean().default(false),
});
export type FreshTab = z.infer<typeof FreshTab>;

const StoredTabs = z.array(FreshTab);

/** A tab's id: short, and safe in an address. */
function newId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

export interface Opened {
  readonly tabs: readonly FreshTab[];
  readonly opened: FreshTab;
}

/**
 * A fresh tab right after `afterPosition`, in the selected project, or the first one when it is not
 * among `projects`; null when there are no projects. A project keeps one fresh tab: when it has one,
 * that tab opens again, keeping its draft and taking the Plan toggle asked for, so the panel never
 * lists two empty New Session rows.
 */
export function openFreshTab(
  tabs: readonly FreshTab[],
  projects: readonly { readonly id: ProjectId }[],
  selected: ProjectId | null,
  afterPosition: number,
  id: string = newId(),
  plan = false,
): Opened | null {
  const project = projects.find((p) => p.id === selected) ?? projects[0];
  if (project === undefined) return null;
  const existing = tabs.find((tab) => tab.projectId === project.id);
  if (existing !== undefined) {
    return { tabs: setFreshPlan(tabs, existing.id, plan), opened: { ...existing, plan } };
  }
  const opened: FreshTab = {
    id,
    projectId: project.id,
    model: null,
    effort: null,
    position: afterPosition + 1,
    plan,
  };
  return { tabs: [...tabs, opened], opened };
}

/** The tab's project changed; its model and effort are the new project's own to choose. */
export function setFreshProject(
  tabs: readonly FreshTab[],
  id: string,
  projectId: ProjectId,
): readonly FreshTab[] {
  return tabs.map((tab) =>
    tab.id === id ? { ...tab, projectId, model: null, effort: null } : tab,
  );
}

export function setFreshModel(
  tabs: readonly FreshTab[],
  id: string,
  model: string | null,
  effort: Effort | null,
): readonly FreshTab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, model, effort } : tab));
}

/** The Plan toggle on a tab before its first message: the session it becomes starts with a Plan or not. */
export function setFreshPlan(
  tabs: readonly FreshTab[],
  id: string,
  plan: boolean,
): readonly FreshTab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, plan } : tab));
}

/** Removing a tab shifts nothing else. */
export function removeFreshTab(tabs: readonly FreshTab[], id: string): readonly FreshTab[] {
  return tabs.filter((tab) => tab.id !== id);
}

/** The tabs kept in this window; a missing, corrupt or unreadable value reads as none. */
export function readFreshTabs(): readonly FreshTab[] {
  try {
    const raw = localStorage.getItem(FRESH_TABS_KEY);
    if (raw === null) return [];
    const parsed = StoredTabs.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Keeps the tabs for the next time the window opens; a full or blocked store loses only that. */
export function writeFreshTabs(tabs: readonly FreshTab[]): void {
  try {
    localStorage.setItem(FRESH_TABS_KEY, JSON.stringify(tabs));
  } catch {
    // The tabs are a convenience; nothing is lost but them.
  }
}
