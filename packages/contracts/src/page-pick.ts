import { z } from 'zod';
import { ProjectId, TaskId } from './ids';

// Pick on Page spec docs/superpowers/specs/2026-11-25-10db-pick-on-page-design.md §3-§5: a pick made in
// a project's Preview window. It is built by a page running agent-written code, checked by the shell,
// and parsed here again by the UI, which only ever puts it in one page's draft as a chip.

/** The most picks one draft holds: a message carries ten pictures, and two stay for pasted ones. */
export const PAGE_PICKS_MAX = 8;
/** The most elements one pick names. */
export const PAGE_PICK_ELEMENTS_MAX = 6;

/** Folders a source path never points into: dependencies and build output. */
const NOT_SOURCE = new Set(['', '.', '..', 'node_modules', '.next', 'dist', '.turbo']);

/**
 * A source path the agent may be pointed at: relative to the project (or its app's folder), inside it,
 * and not a dependency's or a build's. The shell drops any other; this checks again.
 */
export function isProjectSource(file: string): boolean {
  if (file === '' || file.length > 300 || /[\\\0]/.test(file)) return false;
  if (file.startsWith('/') || file.startsWith('~') || file.includes('://')) return false;
  return !file.split('/').some((segment) => NOT_SOURCE.has(segment));
}

const Coordinate = z.number().min(-100_000).max(100_000);

export const PickRect = z.strictObject({
  x: Coordinate,
  y: Coordinate,
  width: Coordinate.nonnegative(),
  height: Coordinate.nonnegative(),
});
export type PickRect = z.infer<typeof PickRect>;

export const PickSource = z.strictObject({
  file: z.string().max(300),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative().optional(),
});
export type PickSource = z.infer<typeof PickSource>;

export const PickElement = z.strictObject({
  tag: z.string().max(40),
  selector: z.string().max(500),
  text: z.string().max(200),
  rect: PickRect,
  component: z.string().max(120).nullable().optional(),
  // A path outside the project is dropped rather than refused, so the pick still arrives.
  source: PickSource.nullable()
    .optional()
    .transform((source) => (source != null && isProjectSource(source.file) ? source : null)),
});
export type PickElement = z.infer<typeof PickElement>;

export const PickKind = { Element: 'element', Group: 'group', Area: 'area' } as const;
export type PickKind = (typeof PickKind)[keyof typeof PickKind];

/** A pick as the page builds it and the shell forwards it. */
export const PagePick = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  kind: z.enum([PickKind.Element, PickKind.Group, PickKind.Area]),
  elements: z.array(PickElement).max(PAGE_PICK_ELEMENTS_MAX),
  area: PickRect.nullable().optional(),
  note: z.string().max(2_000),
  route: z.string().startsWith('/').max(512),
  viewport: z.strictObject({
    width: z.number().positive().max(100_000),
    height: z.number().positive().max(100_000),
    dpr: z.number().positive().max(16),
  }),
  engine: z.string().max(80),
});
export type PagePick = z.infer<typeof PagePick>;
/** What the page sends: a pick before the UI's parse fills its defaults. */
export type PagePickInput = z.input<typeof PagePick>;

/** What the shell emits to the main window as a pick arrives (`preview-pick`). */
export const PickArrived = z.strictObject({
  projectId: ProjectId,
  taskId: TaskId,
  pick: PagePick,
  /** The crop, base64 PNG; null when WebKit gave none. */
  crop: z
    .string()
    .max(8 * 1024 * 1024)
    .nullable(),
});
export type PickArrived = z.infer<typeof PickArrived>;

/** What the shell emits as the page drops a pick (`preview-pick-removed`). */
export const PickRemoved = z.strictObject({ taskId: TaskId, pickId: z.string().max(64) });
export type PickRemoved = z.infer<typeof PickRemoved>;

/** What the shell emits as the page asks for 10db (`preview-show-composer`). */
export const PreviewShowComposer = z.strictObject({ taskId: TaskId });
export type PreviewShowComposer = z.infer<typeof PreviewShowComposer>;

/** The daemon's answer to a preview's sign-in: never a credential. */
export const PreviewSignInDto = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), signedIn: z.boolean() }),
  z.strictObject({ ok: z.literal(false), problem: z.string() }),
]);
export type PreviewSignInDto = z.infer<typeof PreviewSignInDto>;
