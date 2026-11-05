import { createHash } from 'node:crypto';
import {
  ConflictError,
  InvalidError,
  ShapeProposalBody,
  ShapeProposalState,
  ShapeState,
  type PlanDraft,
  type ShapeProposalKind,
  type ShapeId,
  type ShapeMessageId,
  type ShapeProposalId,
} from '@10db/contracts';
import {
  getShape,
  getShapeProposal,
  insertShapeProposal,
  listShapeProposals,
  patchShape,
  patchShapeProposal,
  type Json,
  type ShapeProposalRow,
  type WriteContext,
} from '@10db/db';
import { validatePlan } from './validate';
import { buildPlanWorld } from './world';

// Shape spec §6 Rounds. A `propose_plan` call states the whole plan; each call is one round, reconciled
// against the rows already there in one write, so an edit and a reconcile see each other.

type Marks = ShapeProposalRow['taskHashes'];

/** The pin that holds a row as a whole (Restore). */
export const PIN_WHOLE_ROW = '*';

/** One row of a draft, ready to be stored. */
interface Unit {
  readonly key: string;
  readonly kind: ShapeProposalKind;
  readonly body: Record<string, unknown>;
}

export type ProposeOutcome =
  | {
      readonly ok: true;
      readonly round: number;
      readonly created: readonly string[];
      readonly updated: readonly string[];
      /** Rows the draft left out, now under Earlier. */
      readonly superseded: readonly string[];
      /**
       * Rows the draft left out that were kept because a field is pinned, and a goal's pinned tasks
       * the draft left out of it, named `<goal>.tasks.<task>`.
       */
      readonly kept: readonly string[];
      /** Rows the draft restated that were converted already, which a plan never changes. */
      readonly converted: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function unitsOf(draft: PlanDraft): Unit[] {
  const units: Unit[] = [];
  for (const g of draft.goals) units.push({ key: g.key, kind: 'goal', body: g });
  for (const t of draft.looseTasks) units.push({ key: t.key, kind: 'task', body: t });
  for (const t of draft.additions) units.push({ key: t.key, kind: 'task', body: t });
  for (const l of draft.landings) units.push({ key: l.key, kind: 'landing', body: l });
  for (const r of draft.records) units.push({ key: r.key, kind: r.kind, body: r });
  for (const q of draft.questions) units.push({ key: q.key, kind: 'question', body: q });
  for (const c of draft.changes)
    units.push({ key: `change:${c.taskId}`, kind: 'change_task', body: c });
  for (const r of draft.removals)
    units.push({ key: `remove:${r.taskId}`, kind: 'remove_task', body: r });
  return units;
}

/**
 * A value in the form a hash and a changed-fields mark compare: where it came from is left out, and a
 * list's order doesn't count (spec §6 What changed, and why), so a round that only reorders or recites
 * its sources changes nothing.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonical).sort((a, b) => {
      const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    });
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([field]) => field !== 'sourceMessageIds')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([field, inner]) => [field, canonical(inner)]),
    );
  return value;
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * A task's content hash: what an implementer reads. `ceremony` is how the plan treats the task, not
 * what it asks for, so pinning it neither re-rehearses the task nor answers its questions (§7).
 */
const hashOf = (value: unknown): string => {
  const content = Object.fromEntries(
    Object.entries(asRecord(value)).filter(([field]) => field !== 'ceremony'),
  );
  return createHash('sha256')
    .update(JSON.stringify(canonical(content)))
    .digest('hex')
    .slice(0, 16);
};

/** The fields of `after` that differ from `before`. */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => field !== 'sourceMessageIds' && !same(before[field], after[field]))
    .sort();
}

/**
 * Per task key: the content hash and the fields the round changed. A goal's tasks each get one; a
 * loose task or an addition gets one under its own key.
 */
function marksFor(unit: Unit, previous: Record<string, unknown> | null, before: Marks): Marks {
  if (unit.kind === 'goal') {
    const tasks = Array.isArray(unit.body['tasks']) ? unit.body['tasks'].map(asRecord) : [];
    const priorTasks: unknown = previous?.['tasks'];
    const old = new Map(
      (Array.isArray(priorTasks) ? priorTasks.map(asRecord) : []).map((t) => [t['key'], t]),
    );
    return Object.fromEntries(
      tasks.map((t) => {
        const key = String(t['key']);
        const prior = old.get(key);
        return [
          key,
          {
            hash: hashOf(t),
            changedFields: prior === undefined ? [] : changedFields(prior, t),
          },
        ];
      }),
    );
  }
  if (unit.kind !== 'task') return before;
  return {
    [unit.key]: {
      hash: hashOf(unit.body),
      changedFields: previous === null ? [] : changedFields(previous, unit.body),
    },
  };
}

/**
 * Holds what the builder pinned: a pinned field keeps its stored value over the draft's, a goal's
 * task fields are pinned as `tasks.<key>.<field>`, and a row pinned as a whole is not restated. A
 * pinned task the draft leaves out of its goal is carried over as stored, and named in `keptTasks`.
 */
function withPins(
  draft: Record<string, unknown>,
  stored: Record<string, unknown>,
  pinned: readonly string[],
): { readonly body: Record<string, unknown>; readonly keptTasks: readonly string[] } {
  if (pinned.includes(PIN_WHOLE_ROW)) return { body: stored, keptTasks: [] };
  const merged: Record<string, unknown> = { ...draft };
  const keptTasks: string[] = [];
  for (const pin of pinned) {
    const [head, taskKey, field] = pin.split('.');
    if (head === 'tasks' && taskKey !== undefined && field !== undefined) {
      const draftTasks = Array.isArray(merged['tasks']) ? merged['tasks'].map(asRecord) : [];
      const storedTask = (Array.isArray(stored['tasks']) ? stored['tasks'] : [])
        .map(asRecord)
        .find((t) => t['key'] === taskKey);
      if (storedTask === undefined) continue;
      if (draftTasks.some((t) => t['key'] === taskKey))
        merged['tasks'] = draftTasks.map((t) =>
          t['key'] === taskKey ? { ...t, [field]: storedTask[field] } : t,
        );
      else {
        merged['tasks'] = [...draftTasks, storedTask];
        keptTasks.push(taskKey);
      }
    } else if (head !== undefined && head in stored) merged[head] = stored[head];
  }
  return { body: merged, keptTasks };
}

/** A draft's body, with the source ids it left out filled in from the stored row. */
function withStoredSources(
  body: Record<string, unknown>,
  row: ShapeProposalRow | undefined,
): Record<string, unknown> {
  return body['sourceMessageIds'] === undefined &&
    row !== undefined &&
    row.sourceMessageIds.length > 0
    ? { ...body, sourceMessageIds: row.sourceMessageIds }
    : body;
}

/** A kind as the builder reads it in a refusal: `a task`, `a change task`. */
const withArticle = (kind: ShapeProposalKind): string => `a ${kind.replace('_', ' ')}`;

/** The refusal for a key the builder dropped; `kind` is the dropped row's, which says `change` or `row`. */
const droppedMessage = (key: string, kind: ShapeProposalKind): string =>
  `${key}: the builder dropped this ${kind === 'change_task' ? 'change' : 'row'}; do not propose it again. Raise it in chat as a question if it matters.`;

/** Parses a body as its kind says, so what is stored always reads back. */
function parsedBody(kind: ShapeProposalKind, body: unknown): Record<string, unknown> {
  return asRecord(ShapeProposalBody[kind].parse(body));
}

const sourcesOf = (body: Record<string, unknown>): ShapeMessageId[] =>
  Array.isArray(body['sourceMessageIds']) ? (body['sourceMessageIds'] as ShapeMessageId[]) : [];

/**
 * One round: merge the draft with what is pinned and stored, validate the result, and either answer
 * every error (writing nothing) or write it. Converted rows never change; a dropped key is refused,
 * except a change whose content differs from the one dropped.
 */
export function reconcileDraft(
  ctx: WriteContext,
  shapeId: ShapeId,
  draft: PlanDraft,
): ProposeOutcome {
  const rows = listShapeProposals(ctx.tx, shapeId);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const errors: string[] = [];
  const converted: string[] = [];
  const merged: Unit[] = [];
  const keptTasks: string[] = [];
  const world = buildPlanWorld(ctx.tx, shapeId);
  const isTakenBack = (row: ShapeProposalRow): boolean =>
    row.state === ShapeProposalState.Accepted &&
    row.kind === 'task' &&
    !world.convertedTasks.has(row.key);

  for (const unit of unitsOf(draft)) {
    const row = byKey.get(unit.key);
    // A stored row keeps its kind: a body parsed as another kind would not read back from it.
    if (row !== undefined && row.kind !== unit.kind) {
      // A dropped key stays dropped under any kind: "use another key" would steer toward proposing it again.
      errors.push(
        row.state === ShapeProposalState.Rejected
          ? droppedMessage(unit.key, row.kind)
          : `${unit.key}: stored as ${withArticle(row.kind)}, so it cannot be stated as ${withArticle(unit.kind)}; use another key`,
      );
      continue;
    }
    // An accepted task with no link is an addition Remove Draft Goal took back with its goal: its
    // task is cancelled, so the key is proposed afresh (against the goal's current id) rather than skipped.
    if (row?.state === ShapeProposalState.Accepted && !isTakenBack(row)) {
      converted.push(unit.key);
      continue;
    }
    // A goal's tasks have no row of their own, so a dropped row's key reused as one is found here.
    if (unit.kind === 'goal') {
      const nested = Array.isArray(unit.body['tasks']) ? unit.body['tasks'].map(asRecord) : [];
      const dropped = nested
        .map((t) => byKey.get(String(t['key'])))
        .filter((r) => r?.state === ShapeProposalState.Rejected);
      for (const r of dropped) if (r !== undefined) errors.push(droppedMessage(r.key, r.kind));
    }
    if (row?.state === ShapeProposalState.Rejected) {
      const sameChange =
        unit.kind === 'change_task' && hashOf(unit.body) === hashOf(asRecord(row.body));
      if (unit.kind !== 'change_task' || sameChange) {
        errors.push(droppedMessage(unit.key, unit.kind));
        continue;
      }
    }
    const stored =
      row?.state === ShapeProposalState.Rejected || (row !== undefined && isTakenBack(row))
        ? undefined
        : row;
    const pinnedBody =
      stored === undefined
        ? { body: unit.body, keptTasks: [] }
        : withPins(unit.body, asRecord(stored.body), stored.pinned);
    keptTasks.push(...pinnedBody.keptTasks.map((task) => `${unit.key}.tasks.${task}`));
    merged.push({ ...unit, body: withStoredSources(pinnedBody.body, stored) });
  }

  const mergedDraft = draftOf(merged, draft);
  // Rows the draft leaves out are still citable and findable by key for the rules that read stored rows.
  errors.push(...validatePlan(mergedDraft, world));
  if (errors.length > 0) return { ok: false, errors };

  const shape = getShape(ctx.tx, shapeId);
  const round = shape.round + 1;
  const created: string[] = [];
  const updated: string[] = [];
  const superseded: string[] = [];
  const kept: string[] = [...keptTasks];
  const present = new Set(merged.map((u) => u.key));

  for (const unit of merged) {
    const body = parsedBody(unit.kind, unit.body);
    const row = byKey.get(unit.key);
    if (row === undefined) {
      insertShapeProposal(ctx, {
        shapeId,
        key: unit.key,
        kind: unit.kind,
        state: ShapeProposalState.Pending,
        round,
        createdRound: round,
        pinned: [],
        body: body as Json,
        taskHashes: marksFor({ ...unit, body }, null, {}),
        sourceMessageIds: sourcesOf(body),
      });
      created.push(unit.key);
      continue;
    }
    const revived = row.state === ShapeProposalState.Rejected || isTakenBack(row);
    const previous = revived ? null : asRecord(row.body);
    // A row carries the round that last changed it: restating it unchanged leaves its mark alone.
    const changed = revived || row.state !== ShapeProposalState.Pending || !same(previous, body);
    patchShapeProposal(ctx, row.id, {
      state: ShapeProposalState.Pending,
      ...(changed ? { round } : {}),
      ...(revived ? { createdRound: round, pinned: [] } : {}),
      body: body as Json,
      taskHashes: marksFor({ ...unit, body }, previous, row.taskHashes),
      sourceMessageIds: sourcesOf(body).length > 0 ? sourcesOf(body) : row.sourceMessageIds,
    });
    updated.push(unit.key);
  }
  for (const row of rows) {
    if (present.has(row.key) || row.state !== ShapeProposalState.Pending) continue;
    if (row.pinned.length > 0) kept.push(row.key);
    else {
      patchShapeProposal(ctx, row.id, { state: ShapeProposalState.Superseded, round });
      superseded.push(row.key);
    }
  }

  patchShape(ctx, shapeId, {
    round,
    // A reopened, converted conversation is proposing again once a round makes something pending.
    ...(shape.state === ShapeState.Listening || shape.state === ShapeState.Converted
      ? { state: ShapeState.Proposed }
      : {}),
  });
  return { ok: true, round, created, updated, superseded, kept, converted };
}

/** Rebuilds a `PlanDraft` from merged units so the rules see pinned fields, not the draft alone. */
function draftOf(units: readonly Unit[], draft: PlanDraft): PlanDraft {
  const of = (kind: ShapeProposalKind) => units.filter((u) => u.kind === kind).map((u) => u.body);
  const additionKeys = new Set(draft.additions.map((a) => a.key));
  const tasks = of('task');
  return {
    goals: of('goal'),
    looseTasks: tasks.filter((t) => !additionKeys.has(String(t['key']))),
    additions: tasks.filter((t) => additionKeys.has(String(t['key']))),
    landings: of('landing'),
    records: [...of('decision'), ...of('principle')],
    questions: of('question'),
    changes: of('change_task'),
    removals: of('remove_task'),
  } as PlanDraft;
}

// --- The builder's actions on a row ---------------------------------------------------------------

function pendingRow(ctx: WriteContext, id: ShapeProposalId): ShapeProposalRow {
  const row = getShapeProposal(ctx.tx, id);
  if (row.state === ShapeProposalState.Accepted)
    throw new ConflictError('This proposal was converted; it can no longer be changed');
  return row;
}

/** A row the builder can still act on: not converted, and not dropped (a drop is for good). */
function liveRow(ctx: WriteContext, id: ShapeProposalId): ShapeProposalRow {
  const row = pendingRow(ctx, id);
  if (row.state === ShapeProposalState.Rejected)
    throw new ConflictError('The builder dropped this row; it stays dropped');
  return row;
}

/** A row coming back from Earlier is no longer "moved": it takes the round that made it. */
const comesBack = (row: ShapeProposalRow) =>
  row.state === ShapeProposalState.Superseded
    ? { state: ShapeProposalState.Pending, round: row.createdRound }
    : {};

/**
 * The body with the builder's fields set. A goal's task field is named `tasks.<key>.<field>`, so a
 * pin on it holds that task alone.
 */
function withFields(
  body: Record<string, unknown>,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  let next: Record<string, unknown> = { ...body };
  for (const [name, value] of Object.entries(fields)) {
    const [head, taskKey, field] = name.split('.');
    if (head !== 'tasks' || taskKey === undefined || field === undefined) {
      next[name] = value;
      continue;
    }
    const tasks = Array.isArray(next['tasks']) ? next['tasks'].map(asRecord) : [];
    if (!tasks.some((t) => t['key'] === taskKey))
      throw new InvalidError(`That edit names the task ${taskKey}, which this row does not have`);
    next = {
      ...next,
      tasks: tasks.map((t) => (t['key'] === taskKey ? { ...t, [field]: value } : t)),
    };
  }
  return next;
}

/**
 * The builder sets fields of a row: the values are written, parsed as the row's kind says, and
 * pinned, so no later round changes them. The hash of the task they touched is rewritten.
 */
export function editProposal(
  ctx: WriteContext,
  id: ShapeProposalId,
  fields: Readonly<Record<string, unknown>>,
): void {
  const row = liveRow(ctx, id);
  let body: Record<string, unknown>;
  try {
    body = parsedBody(row.kind, withFields(asRecord(row.body), fields));
  } catch (error) {
    if (error instanceof InvalidError) throw error;
    throw new InvalidError(
      `That edit does not fit a ${row.kind}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const marks = marksFor(
    { key: row.key, kind: row.kind, body },
    asRecord(row.body),
    row.taskHashes,
  );
  patchShapeProposal(ctx, id, {
    body: body as Json,
    taskHashes: marks,
    pinned: [...new Set([...row.pinned, ...Object.keys(fields)])],
    ...comesBack(row),
  });
}

/**
 * Restore: a row from Earlier comes back, held as a whole until the builder unpins or drops it. On a
 * pending row it pins the row as a whole.
 */
export function restoreProposal(ctx: WriteContext, id: ShapeProposalId): void {
  const row = liveRow(ctx, id);
  patchShapeProposal(ctx, id, {
    ...comesBack(row),
    pinned: [...new Set([...row.pinned, PIN_WHOLE_ROW])],
  });
}

/** Unpin: one field is the draft's again, or with no field the row as a whole. */
export function unpinProposal(ctx: WriteContext, id: ShapeProposalId, field?: string): void {
  const row = liveRow(ctx, id);
  if (field === undefined) {
    patchShapeProposal(ctx, id, { pinned: [] });
    return;
  }
  if (!row.pinned.includes(field)) throw new InvalidError(`${field} is not pinned`);
  patchShapeProposal(ctx, id, { pinned: row.pinned.filter((p) => p !== field) });
}

/** Drop: the row is rejected and stays as a tombstone, so a draft reusing its key is refused. */
export function dropProposal(ctx: WriteContext, id: ShapeProposalId): void {
  const row = pendingRow(ctx, id);
  if (row.state === ShapeProposalState.Rejected) return;
  patchShapeProposal(ctx, id, { state: ShapeProposalState.Rejected });
}
