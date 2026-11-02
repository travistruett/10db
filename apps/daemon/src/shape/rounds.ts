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
      /** Rows the draft left out that were kept because a field is pinned. */
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

/** The part of a body a hash and a changed-fields mark look at: everything but where it came from. */
function content(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([field]) => field !== 'sourceMessageIds'));
}

const hashOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** The fields of `after` that differ from `before`. */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
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
            hash: hashOf(content(t)),
            changedFields: prior === undefined ? [] : changedFields(content(prior), content(t)),
          },
        ];
      }),
    );
  }
  if (unit.kind !== 'task') return before;
  return {
    [unit.key]: {
      hash: hashOf(content(unit.body)),
      changedFields: previous === null ? [] : changedFields(content(previous), content(unit.body)),
    },
  };
}

/**
 * Holds what the builder pinned: a pinned field keeps its stored value over the draft's, a goal's
 * task fields are pinned as `tasks.<key>.<field>`, and a row pinned as a whole is not restated.
 */
function withPins(
  draft: Record<string, unknown>,
  stored: Record<string, unknown>,
  pinned: readonly string[],
): Record<string, unknown> {
  if (pinned.includes(PIN_WHOLE_ROW)) return stored;
  const merged: Record<string, unknown> = { ...draft };
  for (const pin of pinned) {
    const [head, taskKey, field] = pin.split('.');
    if (head === 'tasks' && taskKey !== undefined && field !== undefined) {
      const draftTasks = Array.isArray(merged['tasks']) ? merged['tasks'].map(asRecord) : [];
      const storedTask = (Array.isArray(stored['tasks']) ? stored['tasks'] : [])
        .map(asRecord)
        .find((t) => t['key'] === taskKey);
      if (storedTask !== undefined)
        merged['tasks'] = draftTasks.map((t) =>
          t['key'] === taskKey ? { ...t, [field]: storedTask[field] } : t,
        );
    } else if (head !== undefined && head in stored) merged[head] = stored[head];
  }
  return merged;
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

  for (const unit of unitsOf(draft)) {
    const row = byKey.get(unit.key);
    if (row?.state === ShapeProposalState.Accepted) {
      converted.push(unit.key);
      continue;
    }
    if (row?.state === ShapeProposalState.Rejected) {
      const sameChange =
        unit.kind === 'change_task' &&
        hashOf(content(unit.body)) === hashOf(content(asRecord(row.body)));
      if (unit.kind !== 'change_task' || sameChange) {
        errors.push(
          `${unit.key}: the builder dropped this ${unit.kind === 'change_task' ? 'change' : 'row'}; do not propose it again. Raise it in chat as a question if it matters.`,
        );
        continue;
      }
    }
    const stored = row?.state === ShapeProposalState.Rejected ? undefined : row;
    const body = withStoredSources(
      stored === undefined ? unit.body : withPins(unit.body, asRecord(stored.body), stored.pinned),
      stored,
    );
    merged.push({ ...unit, body });
  }

  const mergedDraft = draftOf(merged, draft);
  // Rows the draft leaves out are still citable and findable by key for the rules that read stored rows.
  errors.push(...validatePlan(mergedDraft, buildPlanWorld(ctx.tx, shapeId)));
  if (errors.length > 0) return { ok: false, errors };

  const shape = getShape(ctx.tx, shapeId);
  const round = shape.round + 1;
  const created: string[] = [];
  const updated: string[] = [];
  const superseded: string[] = [];
  const kept: string[] = [];
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
        pinned: [],
        body: body as Json,
        taskHashes: marksFor({ ...unit, body }, null, {}),
        sourceMessageIds: sourcesOf(body),
      });
      created.push(unit.key);
      continue;
    }
    const previous = row.state === ShapeProposalState.Rejected ? null : asRecord(row.body);
    patchShapeProposal(ctx, row.id, {
      state: ShapeProposalState.Pending,
      round,
      body: body as Json,
      taskHashes: marksFor({ ...unit, body }, previous, row.taskHashes),
      sourceMessageIds: sourcesOf(body).length > 0 ? sourcesOf(body) : row.sourceMessageIds,
      ...(row.state === ShapeProposalState.Rejected ? { pinned: [] } : {}),
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
    ...(shape.state === ShapeState.Listening ? { state: ShapeState.Proposed } : {}),
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

/**
 * The builder sets fields of a row: the values are written, parsed as the row's kind says, and
 * pinned, so no later round changes them. The hash of the task they touched is rewritten.
 */
export function editProposal(
  ctx: WriteContext,
  id: ShapeProposalId,
  fields: Readonly<Record<string, unknown>>,
): void {
  const row = pendingRow(ctx, id);
  let body: Record<string, unknown>;
  try {
    body = parsedBody(row.kind, { ...asRecord(row.body), ...fields });
  } catch (error) {
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
    state: row.state === ShapeProposalState.Superseded ? ShapeProposalState.Pending : row.state,
  });
}

/** Restore: a row from Earlier comes back, held as a whole until the builder unpins or drops it. */
export function restoreProposal(ctx: WriteContext, id: ShapeProposalId): void {
  const row = pendingRow(ctx, id);
  patchShapeProposal(ctx, id, {
    state: ShapeProposalState.Pending,
    pinned: [...new Set([...row.pinned, PIN_WHOLE_ROW])],
  });
}

/** Drop: the row is rejected and stays as a tombstone, so a draft reusing its key is refused. */
export function dropProposal(ctx: WriteContext, id: ShapeProposalId): void {
  pendingRow(ctx, id);
  patchShapeProposal(ctx, id, { state: ShapeProposalState.Rejected });
}
