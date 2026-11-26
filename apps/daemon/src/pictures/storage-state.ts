import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CopyId, ProjectId } from '@10db/contracts';
import { z } from 'zod';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10, §13: a project's sign-in
// to its dev app, as Playwright writes it. It is a credential: kept under the data directory, mode 0600.

const Cookie = z.looseObject({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']),
});

const OriginStorage = z.looseObject({
  origin: z.string(),
  localStorage: z.array(z.looseObject({ name: z.string(), value: z.string() })),
});

/**
 * Playwright's storage state: cookies and per-origin localStorage. A field a later Playwright adds is
 * kept, so the browser gets back what it wrote.
 */
export const StorageState = z.looseObject({
  cookies: z.array(Cookie),
  origins: z.array(OriginStorage),
});
export type StorageState = z.infer<typeof StorageState>;

/** Where a project's browser state and its dev login's log are kept: under the data dir, 0700. */
export const browserDir = (dataDir: string, projectId: ProjectId): string =>
  join(dataDir, 'browser', projectId);

/** A separate copy's sign-in is its own: it signs in to the copy's databases, not the shared app's. */
const COPY_STATE = /^copy-[0-9a-f]{12}\.json$/;

const statePath = (dataDir: string, projectId: ProjectId, copyId: CopyId | null): string =>
  join(browserDir(dataDir, projectId), copyId === null ? 'state.json' : `copy-${copyId}.json`);

/** The project's kept sign-in, or a copy's; null when there is none or the file is not one. */
export function readStorageState(
  dataDir: string,
  projectId: ProjectId,
  copyId: CopyId | null = null,
): StorageState | null {
  let text: string;
  try {
    text = readFileSync(statePath(dataDir, projectId, copyId), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = StorageState.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Keeps the project's sign-in, or a copy's, readable by this user alone, through a temporary name and a rename. */
export function writeStorageState(
  dataDir: string,
  projectId: ProjectId,
  state: StorageState,
  copyId: CopyId | null = null,
): void {
  const dir = browserDir(dataDir, projectId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.state.${randomUUID()}.part`);
  try {
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, statePath(dataDir, projectId, copyId));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Forgets the project's sign-in and every copy's, as when its app address or a command changes. A
 * cookie on localhost is shared by every port, so a copy's state is never kept past the project's.
 */
export function forgetStorageState(dataDir: string, projectId: ProjectId): void {
  rmSync(statePath(dataDir, projectId, null), { force: true });
  let names: string[];
  try {
    names = readdirSync(browserDir(dataDir, projectId));
  } catch {
    return;
  }
  for (const name of names)
    if (COPY_STATE.test(name)) rmSync(join(browserDir(dataDir, projectId), name), { force: true });
}
