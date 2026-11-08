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
 * Adds each draft to the hazard it names, in the project's own hazard list, and records it with its
 * evidence. A value the hazard already holds, one the builder took out before, and one twice in the
 * batch are left out. A hazard the project lacks is made, held by the whole project, only when the batch
 * gives it a glob; an area's name is never made a hazard. Returns what was added.
 */
export function applyHazardAdditions(
  ctx: WriteContext,
  projectId: ProjectId,
  drafts: readonly HazardAdditionDraft[],
): HazardAdditionDto[] {
  const project = getProject(ctx.tx, projectId);
  const state = readHazardAssessment(ctx.tx, projectId);
  const areaNames = new Set(project.areas.map((a) => a.name));
  const hazards = project.hazards.map((h) => ({ ...h }));
  const taken: Entry[] = [];
  const added: HazardAdditionDto[] = [];
  for (const draft of drafts) {
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
      if (!drafts.some((d) => d.hazard === draft.hazard && d.kind === HazardEntryKind.Glob))
        continue;
      hazards.push({
        name: draft.hazard,
        globs: entry.kind === HazardEntryKind.Glob ? [entry.value] : [],
        commands: entry.kind === HazardEntryKind.Command ? [entry.value] : [],
        scope: HazardScope.Project,
      });
    }
    taken.push(entry);
    added.push({ ...draft, id: randomUUID(), addedAt: ctx.now });
  }
  // A hazard made from a command seen before its glob has no globs yet; fill in order.
  for (const hazard of hazards) {
    if (hazard.globs.length > 0) continue;
    const globs = added.filter((a) => a.hazard === hazard.name && a.kind === HazardEntryKind.Glob);
    hazard.globs = globs.map((g) => g.value);
  }
  if (added.length === 0) return [];
  patchProject(ctx, projectId, { hazards });
  write(ctx, projectId, { ...state, additions: [...state.additions, ...added] });
  return added;
}

function takeOut(
  ctx: WriteContext,
  projectId: ProjectId,
  entries: readonly Entry[],
): HazardAssessmentState {
  const project = getProject(ctx.tx, projectId);
  const state = readHazardAssessment(ctx.tx, projectId);
  const hazards = project.hazards
    .map((h) => entries.filter((e) => e.hazard === h.name).reduce(without, h))
    .filter(stillAHazard);
  const changed = JSON.stringify(hazards) !== JSON.stringify(project.hazards);
  if (changed) patchProject(ctx, projectId, { hazards });
  const gone = new Set(
    project.hazards.map((h) => h.name).filter((n) => !hazards.some((h) => h.name === n)),
  );
  return {
    ...state,
    additions: state.additions.filter((a) => !holds(entries, entryOf(a)) && !gone.has(a.hazard)),
    declined: [...state.declined, ...entries.filter((e) => !holds(state.declined, e))],
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
