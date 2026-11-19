import { ProjectId } from '@10db/contracts';
import { z } from 'zod';

// The projects whose sessions the builder folded away in the Sessions panel, kept per window in
// `localStorage`. The read and the write are the only effects, each in try/catch.

export const COLLAPSED_PROJECTS_KEY = 'tendb.sessions.collapsed';

const Stored = z.array(ProjectId);

export function readCollapsed(): ReadonlySet<ProjectId> {
  try {
    const raw = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (raw === null) return new Set();
    // Stored JSON from this window's own writes; the schema checks it all the same.
    const parsed = Stored.safeParse(JSON.parse(raw));
    return new Set(parsed.success ? parsed.data : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsed(collapsed: ReadonlySet<ProjectId>): void {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]));
  } catch {
    // A window that can't store keeps the fold for as long as it is open.
  }
}
