import { z } from 'zod';
import { ModelSetting } from './catalogue';
import { KindId, PersonaId } from './ids';
import { HyphenatedKey } from './keys';
import { Effort, StepRole } from './states';

type ValueOf<T> = T[keyof T];

/** How much process a task gets, weakest first. */
export const Rigor = {
  Light: 'light',
  Standard: 'standard',
  Careful: 'careful',
  Critical: 'critical',
} as const;
export type Rigor = ValueOf<typeof Rigor>;

/** Every rigor, weakest first. */
export const RIGORS: readonly Rigor[] = [
  Rigor.Light,
  Rigor.Standard,
  Rigor.Careful,
  Rigor.Critical,
];

/** Whether `rigor` is `minimum` or stronger. */
export function rigorAtLeast(rigor: Rigor, minimum: Rigor): boolean {
  return RIGORS.indexOf(rigor) >= RIGORS.indexOf(minimum);
}

/**
 * The rigor a task runs at: its own, else the project's default, and never below the highest minimum
 * of its kinds. A key no kind has adds no minimum.
 */
export function effectiveRigor(input: {
  readonly rigor: Rigor | null;
  readonly projectDefault: Rigor;
  readonly taskKinds: readonly { readonly key: string }[];
  readonly kinds: readonly { readonly key: string; readonly minimumRigor: Rigor | null }[];
}): Rigor {
  const own = input.rigor ?? input.projectDefault;
  const keys = new Set(input.taskKinds.map((k) => k.key));
  const minimums = input.kinds
    .filter((k) => keys.has(k.key))
    .map((k) => k.minimumRigor)
    .filter((m): m is Rigor => m !== null);
  const strongest = RIGORS.filter((r) => minimums.includes(r)).at(-1);
  return strongest !== undefined && !rigorAtLeast(own, strongest) ? strongest : own;
}

/** Who gave a task one of its kinds: the builder (which pins it) or an agent. */
export const TaskKindSource = { Builder: 'builder', Agent: 'agent' } as const;
export type TaskKindSource = ValueOf<typeof TaskKindSource>;

/** A kind a task has, by the kind's key, and who gave it. */
export const TaskKind = z.object({
  key: HyphenatedKey,
  source: z.enum(TaskKindSource),
});
export type TaskKind = z.infer<typeof TaskKind>;

/** What a playbook cell or a kind's override says about a step; null leaves the field to the next level. */
export const CellSetting = z.object({
  personaId: PersonaId.nullable().default(null),
  model: ModelSetting.nullable().default(null),
  effort: z.enum(Effort).nullable().default(null),
});
export type CellSetting = z.infer<typeof CellSetting>;

const Steps = z.array(z.enum(StepRole)).refine((steps) => steps.includes(StepRole.Implement), {
  message: 'A rigor always runs the build step',
});

const noneTwice = (keys: readonly string[]) => new Set(keys).size === keys.length;

/**
 * What a form changes in one scope's playbook. A row with null `steps`, and a cell with every field null,
 * is cleared: the scope above (or the default) applies again. A row or cell left out keeps what it has.
 */
export const PlaybookInput = z.object({
  rows: z
    .array(z.object({ rigor: z.enum(Rigor), steps: Steps.nullable() }))
    .refine((rows) => noneTwice(rows.map((r) => r.rigor)), { message: 'A rigor is set twice' })
    .default([]),
  cells: z
    .array(CellSetting.extend({ rigor: z.enum(Rigor), role: z.enum(StepRole) }))
    .refine((cells) => noneTwice(cells.map((c) => `${c.rigor}/${c.role}`)), {
      message: 'A cell is set twice',
    })
    .default([]),
});
export type PlaybookInput = z.input<typeof PlaybookInput>;

/** Where a value in the playbook comes from: 10db's default, a global override or the project's own. */
export const PlaybookSource = { Default: 'default', Global: 'global', Project: 'project' } as const;
export type PlaybookSource = ValueOf<typeof PlaybookSource>;

const sourced = <T extends z.ZodType>(value: T) =>
  z.object({ value, source: z.enum(PlaybookSource) });

/** One rigor's steps, as they stand for a scope. */
export const PlaybookRowDto = z.object({
  rigor: z.enum(Rigor),
  steps: sourced(Steps),
});
export type PlaybookRowDto = z.infer<typeof PlaybookRowDto>;

/** One cell, each field with the scope that set it. */
export const PlaybookCellDto = z.object({
  rigor: z.enum(Rigor),
  role: z.enum(StepRole),
  personaId: sourced(PersonaId.nullable()),
  model: sourced(ModelSetting.nullable()),
  effort: sourced(z.enum(Effort).nullable()),
});
export type PlaybookCellDto = z.infer<typeof PlaybookCellDto>;

export const PlaybookDto = z.object({
  rows: z.array(PlaybookRowDto),
  cells: z.array(PlaybookCellDto),
});
export type PlaybookDto = z.infer<typeof PlaybookDto>;

const KindOverrides = z.partialRecord(z.enum(StepRole), CellSetting);

const KindFields = {
  label: z.string().trim().min(1).max(60),
  /** One line the judge reads to decide whether a task is this kind. */
  description: z.string().trim().max(300),
  /** The lowest rigor a task of this kind gets; null for none. */
  minimumRigor: z.enum(Rigor).nullable(),
  /** Review is never skipped. */
  alwaysReviewed: z.boolean(),
  /** A send-back at the round limit fails the task rather than shipping it. */
  failsAtLimit: z.boolean(),
  /** Placement puts the task in its own copy. */
  ownCopy: z.boolean(),
  /** A lane's proposal of this kind goes to the Inbox, not the Icebox. */
  toInbox: z.boolean(),
  /** Steps the rigor's row does not run that a task of this kind runs anyway. */
  addsSteps: z.array(z.enum(StepRole)),
  overrides: KindOverrides,
};

export const KindDto = z.object({
  id: KindId,
  key: HyphenatedKey,
  ...KindFields,
  position: z.int().min(0),
});
export type KindDto = z.infer<typeof KindDto>;

/** A kind as the builder writes it; the daemon gives it an id and its place in the list. */
export const KindInput = z.object({
  key: HyphenatedKey,
  ...KindFields,
  description: KindFields.description.default(''),
  minimumRigor: KindFields.minimumRigor.default(null),
  alwaysReviewed: KindFields.alwaysReviewed.default(false),
  failsAtLimit: KindFields.failsAtLimit.default(false),
  ownCopy: KindFields.ownCopy.default(false),
  toInbox: KindFields.toInbox.default(false),
  addsSteps: KindFields.addsSteps.default([]),
  overrides: KindFields.overrides.default({}),
});
export type KindInput = z.input<typeof KindInput>;

/** What changes on a kind; its key never does, so a patch that names one is refused. */
export const KindPatch = z.strictObject({ ...KindFields }).partial();
export type KindPatch = z.infer<typeof KindPatch>;
