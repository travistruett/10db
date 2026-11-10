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
