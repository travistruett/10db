import { randomUUID } from 'node:crypto';
import {
  HazardAdditionDto,
  HazardEntryKind,
  HazardScope,
  NotFoundError,
  type HazardAdditionDraft,
  type HazardDef,
  type HazardRemoval,
  type ProjectId,
} from '@10db/contracts';
import { z } from 'zod';
import type { Json } from '../json';
import { getProject, patchProject } from './projects';
import { getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';

const key = (projectId: ProjectId): string => `hazard-assessment:${projectId}`;

/** A glob or command of one hazard, without who added it. */
const Entry = z.object({
  hazard: z.string(),
  kind: z.enum([HazardEntryKind.Glob, HazardEntryKind.Command]),
  value: z.string(),
});
type Entry = z.infer<typeof Entry>;

const State = z.object({
  /** What 10db added that is still in the hazards. */
  additions: z.array(HazardAdditionDto),
  /** What the builder took out (an undo, or a removal they agreed to): never added again. */
  declined: z.array(Entry),
  /** What a removal card proposed and the builder kept: not proposed again. */
  kept: z.array(Entry),
  assessedAt: z.iso.datetime().nullable(),
  commit: z.string().nullable(),
});
export type HazardAssessmentState = z.infer<typeof State>;

const EMPTY: HazardAssessmentState = {
  additions: [],
  declined: [],
  kept: [],
  assessedAt: null,
  commit: null,
};

/** What was last assessed for a project, and what 10db added and was told to leave out. */
export function readHazardAssessment(db: DbReader, projectId: ProjectId): HazardAssessmentState {
  const stored = State.safeParse(getAppSetting(db, key(projectId)));
  return stored.success ? stored.data : EMPTY;
}

function write(ctx: WriteContext, projectId: ProjectId, state: HazardAssessmentState): void {
  // The state is validated JSON, so it is a Json value.
  setAppSetting(ctx, key(projectId), state as unknown as Json);
}

const same = (a: Entry, b: Entry): boolean =>
  a.hazard === b.hazard && a.kind === b.kind && a.value === b.value;
const holds = (list: readonly Entry[], entry: Entry): boolean => list.some((e) => same(e, entry));
const entryOf = ({ hazard, kind, value }: Entry): Entry => ({ hazard, kind, value });

function has(hazard: HazardDef, entry: Entry): boolean {
  return (entry.kind === HazardEntryKind.Glob ? hazard.globs : hazard.commands).includes(
    entry.value,
  );
}

function without(hazard: HazardDef, entry: Entry): HazardDef {
  return entry.kind === HazardEntryKind.Glob
    ? { ...hazard, globs: hazard.globs.filter((g) => g !== entry.value) }
    : { ...hazard, commands: hazard.commands.filter((c) => c !== entry.value) };
}

/** A hazard with no path left holds nothing a project can store, so it goes. */
const stillAHazard = (hazard: HazardDef): boolean => hazard.globs.length > 0;

/**
 * The state with every recorded addition the hazards no longer hold moved to `declined`: the builder
 * took it out by hand (in Settings, or by deleting its hazard), and a removal made by hand sticks as
 * an Undo does.
 */
function reconciled(
  hazards: readonly HazardDef[],
  state: HazardAssessmentState,
): HazardAssessmentState {
  const isHeld = (a: Entry): boolean => {
    const hazard = hazards.find((h) => h.name === a.hazard);
    return hazard !== undefined && has(hazard, a);
  };
  const gone = state.additions.filter((a) => !isHeld(a)).map(entryOf);
  if (gone.length === 0) return state;
  return {
    ...state,
    additions: state.additions.filter(isHeld),
    declined: [...state.declined, ...gone.filter((e) => !holds(state.declined, e))],
  };
}

/** The additions the project's hazards still hold, which is what Settings lists as added. */
export function heldHazardAdditions(db: DbReader, projectId: ProjectId): HazardAdditionDto[] {
  return reconciled(getProject(db, projectId).hazards, readHazardAssessment(db, projectId))
    .additions;
}

/**
 * Records as declined every addition the builder has since taken out of the hazards by hand, so it
 * is neither listed as added nor added again. Returns the state as now stored.
 */
export function reconcileHazardAssessment(
  ctx: WriteContext,
  projectId: ProjectId,
): HazardAssessmentState {
  const state = readHazardAssessment(ctx.tx, projectId);
  const next = reconciled(getProject(ctx.tx, projectId).hazards, state);
  if (next !== state) write(ctx, projectId, next);
  return next;
}

/**
 * Adds each draft to the hazard it names, in the project's own hazard list, and records it with its
 * evidence. A value the hazard already holds, one the builder took out before (by Undo, an agreed
 * removal or by hand), and one twice in the batch are left out. A hazard the project lacks is made,
 * held by the whole project, only from a glob the batch actually adds; a command for a hazard that is
 * neither held nor made is dropped, so no hazard is ever left with no glob. An area's name is never
 * made a hazard. Returns what was added, in the order of the drafts.
 */
export function applyHazardAdditions(
  ctx: WriteContext,
  projectId: ProjectId,
  drafts: readonly HazardAdditionDraft[],
): HazardAdditionDto[] {
  const project = getProject(ctx.tx, projectId);
  const state = reconcileHazardAssessment(ctx, projectId);
  const areaNames = new Set(project.areas.map((a) => a.name));
  const hazards = project.hazards.map((h) => ({ ...h }));
  const taken: Entry[] = [];
  const added: { index: number; addition: HazardAdditionDto }[] = [];
  // Globs first, so a hazard is made only from a glob that is really added.
  const order = drafts
    .map((draft, index) => ({ draft, index }))
    .sort(
      (a, b) =>
        Number(a.draft.kind !== HazardEntryKind.Glob) -
          Number(b.draft.kind !== HazardEntryKind.Glob) || a.index - b.index,
    );
  for (const { draft, index } of order) {
    const entry = entryOf(draft);
    if (holds(state.declined, entry) || holds(taken, entry)) continue;
    if (areaNames.has(draft.hazard)) continue;
    const target = hazards.find((h) => h.name === draft.hazard);
    if (target !== undefined) {
      if (has(target, entry)) continue;
      if (entry.kind === HazardEntryKind.Glob) target.globs = [...target.globs, entry.value];
      else target.commands = [...target.commands, entry.value];
    } else {
      // A hazard needs a path, so a command alone has nothing to start one with.
      if (entry.kind !== HazardEntryKind.Glob) continue;
      hazards.push({
        name: draft.hazard,
        globs: [entry.value],
        commands: [],
        scope: HazardScope.Project,
      });
    }
    taken.push(entry);
    added.push({ index, addition: { ...draft, id: randomUUID(), addedAt: ctx.now } });
  }
  if (added.length === 0) return [];
  const additions = added.sort((a, b) => a.index - b.index).map((a) => a.addition);
  patchProject(ctx, projectId, { hazards: hazards.filter(stillAHazard) });
  write(ctx, projectId, { ...state, additions: [...state.additions, ...additions] });
  return additions;
}

function takeOut(
  ctx: WriteContext,
  projectId: ProjectId,
  entries: readonly Entry[],
): HazardAssessmentState {
  const project = getProject(ctx.tx, projectId);
  const state = reconciled(project.hazards, readHazardAssessment(ctx.tx, projectId));
  const hazards = project.hazards
    .map((h) => entries.filter((e) => e.hazard === h.name).reduce(without, h))
    .filter(stillAHazard);
  const changed = JSON.stringify(hazards) !== JSON.stringify(project.hazards);
  if (changed) patchProject(ctx, projectId, { hazards });
  const gone = new Set(
    project.hazards.map((h) => h.name).filter((n) => !hazards.some((h) => h.name === n)),
  );
  // What 10db added to a hazard that went with its last glob was taken out too.
  const out = [...entries, ...state.additions.filter((a) => gone.has(a.hazard)).map(entryOf)];
  const declined = [...state.declined];
  for (const entry of out) if (!holds(declined, entry)) declined.push(entry);
  return {
    ...state,
    additions: state.additions.filter((a) => !holds(out, entryOf(a))),
    declined,
    kept: state.kept.filter((k) => !holds(entries, k)),
  };
}

/** Takes one addition back out of its hazard; it is not added again. */
export function undoHazardAddition(
  ctx: WriteContext,
  projectId: ProjectId,
  additionId: string,
): void {
  const state = readHazardAssessment(ctx.tx, projectId);
  const addition = state.additions.find((a) => a.id === additionId);
  if (addition === undefined) throw new NotFoundError('hazard addition', additionId);
  write(ctx, projectId, takeOut(ctx, projectId, [entryOf(addition)]));
}

/**
 * Takes out the entries a removal card listed, once the builder agreed: they leave their hazards, any
 * addition of them is forgotten and they are not added again.
 */
export function applyHazardRemovals(
  ctx: WriteContext,
  projectId: ProjectId,
  removals: readonly HazardRemoval[],
): void {
  write(ctx, projectId, takeOut(ctx, projectId, removals.map(entryOf)));
}

/** Records that the builder kept what a removal card listed, so it is not proposed again. */
export function keepHazards(
  ctx: WriteContext,
  projectId: ProjectId,
  removals: readonly HazardRemoval[],
): void {
  const state = readHazardAssessment(ctx.tx, projectId);
  const kept = [...state.kept];
  for (const removal of removals.map(entryOf)) if (!holds(kept, removal)) kept.push(removal);
  write(ctx, projectId, { ...state, kept });
}

/** Records that the repository was read to the end at `commit`. */
export function recordHazardRead(ctx: WriteContext, projectId: ProjectId, commit: string): void {
  write(ctx, projectId, {
    ...readHazardAssessment(ctx.tx, projectId),
    assessedAt: ctx.now,
    commit,
  });
}
