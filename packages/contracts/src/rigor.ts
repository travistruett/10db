import { z } from 'zod';
import { ModelSetting } from './catalogue';
import { DomainError } from './errors';
import { AccountId, KindId, PersonaId, ProjectId } from './ids';
import { HyphenatedKey } from './keys';
import { Effort, RiskTag, StepRole } from './states';

type ValueOf<T> = T[keyof T];

/** How much process a task gets, weakest first. */
export const Rigor = {
  Light: 'light',
  Standard: 'standard',
  Careful: 'careful',
  Critical: 'critical',
} as const;
export type Rigor = ValueOf<typeof Rigor>;

/** A rigor as the builder reads it. */
const rigorTitle = (rigor: Rigor): string => rigor.charAt(0).toUpperCase() + rigor.slice(1);

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

const Steps = z
  .array(z.enum(StepRole))
  .refine((steps) => steps.includes(StepRole.Implement), {
    message: 'A rigor always runs the build step',
  })
  .refine((steps) => !steps.includes(StepRole.PlanReview) || steps.includes(StepRole.Plan), {
    message: 'A plan review needs a plan to judge',
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

/**
 * One setting the move to the playbook could not carry over: what it was, its value, and why it has no
 * place in the playbook. The entries of the global scope are kept as an app setting; a project's go on a card.
 */
export const PlaybookMoveEntry = z.object({
  setting: z.string().min(1),
  value: z.string(),
  why: z.string().min(1),
});
export type PlaybookMoveEntry = z.infer<typeof PlaybookMoveEntry>;

/** Where a kind goes in the builder's order: 0 is first, and past the end is last. */
export const KindOrderInput = z.strictObject({ kindId: KindId, position: z.int().min(0) });
export type KindOrderInput = z.infer<typeof KindOrderInput>;

/**
 * Which account's offer the router's picks are made on, at which rigor's cells (Standard when left
 * out), and for which project's playbook (the global one when left out). The query string carries the
 * rigor as its word.
 */
export const ModelPicksQuery = z.strictObject({
  account: AccountId,
  rigor: z.enum(Rigor).optional(),
  project: ProjectId.optional(),
});
export type ModelPicksQuery = z.infer<typeof ModelPicksQuery>;

/** A task's own rigor is below what a kind it has asks for; the message names the kind and its minimum. */
export class RigorBelowKindError extends DomainError {
  override readonly name = 'RigorBelowKindError';
  readonly kindKey: string;
  readonly minimum: Rigor;
  constructor(
    kind: { readonly key: string; readonly label: string },
    minimum: Rigor,
    rigor: Rigor,
  ) {
    super(
      'invalid',
      `${kind.label} work is at least ${rigorTitle(minimum)}, so a task of that kind can't be ${rigorTitle(rigor)}; choose ${rigorTitle(minimum)} or stronger, or take off the ${kind.key} kind`,
    );
    this.kindKey = kind.key;
    this.minimum = minimum;
  }
}

/**
 * Refuses a rigor the builder set that is below the minimum of a kind the task has, naming the kind that
 * holds the floor (the strongest one when several do). A task with no rigor of its own follows the floor,
 * and a key no kind has holds none.
 */
export function refuseRigorBelowKinds(input: {
  readonly rigor: Rigor | null;
  readonly taskKinds: readonly { readonly key: string }[];
  readonly kinds: readonly {
    readonly key: string;
    readonly label: string;
    readonly minimumRigor: Rigor | null;
  }[];
}): void {
  if (input.rigor === null) return;
  const keys = new Set(input.taskKinds.map((k) => k.key));
  let holder: { key: string; label: string; minimum: Rigor } | null = null;
  for (const kind of input.kinds) {
    const minimum = kind.minimumRigor;
    if (minimum === null || !keys.has(kind.key) || rigorAtLeast(input.rigor, minimum)) continue;
    if (holder === null || rigorAtLeast(minimum, holder.minimum))
      holder = { key: kind.key, label: kind.label, minimum };
  }
  if (holder !== null) throw new RigorBelowKindError(holder, holder.minimum, input.rigor);
}

/**
 * The kinds a task has, as the rows that name them, in the builder's order of kinds. A key no kind has
 * (its kind was deleted) means nothing, so it is left out.
 */
export function kindsOfTask<K extends { readonly key: string }>(
  taskKinds: readonly { readonly key: string }[],
  kinds: readonly K[],
): K[] {
  const keys = new Set(taskKinds.map((k) => k.key));
  return kinds.filter((k) => keys.has(k.key));
}

/**
 * The task's kinds with each of `keys` added that some known kind has and the task lacks, given by `source`.
 * Keys no kind has are dropped, so what comes back is always storable.
 */
export function withKindsNamed(
  taskKinds: readonly TaskKind[],
  keys: readonly string[],
  known: readonly { readonly key: string }[],
  source: TaskKindSource,
): TaskKind[] {
  const have = new Set(taskKinds.map((k) => k.key));
  const exists = new Set(known.map((k) => k.key));
  const added: TaskKind[] = [];
  for (const key of keys) {
    if (have.has(key) || !exists.has(key)) continue;
    have.add(key);
    added.push({ key, source });
  }
  return [...taskKinds, ...added];
}

/**
 * The task's kinds after an edit that still names risk tags, the older name of the security, auth,
 * migration and dependency kinds: those four kinds are set to match `riskTags`, every other kind stays as it
 * is. A tag whose kind does not exist adds nothing.
 */
export function kindsMatchingRiskTags(
  taskKinds: readonly TaskKind[],
  riskTags: readonly RiskTag[],
  known: readonly { readonly key: string }[],
  source: TaskKindSource,
): TaskKind[] {
  const risky = new Set<string>(Object.values(RiskTag));
  const kept = taskKinds.filter((k) => !risky.has(k.key) || riskTags.some((tag) => tag === k.key));
  return withKindsNamed(kept, riskTags, known, source);
}
