import {
  InvalidError,
  NotFoundError,
  ShapeFindingKind,
  ShapeFindingState,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeProposalBody,
  ShapeProposalKind,
  ShapeProposalState,
  ShapeReviewer,
  type ShapeFindingId,
  type ShapeId,
  type ShapeProposalId,
  type ShapeToolInputs,
} from '@10db/contracts';
import {
  getShape,
  getShapeFinding,
  insertShapeFinding,
  insertShapeMessage,
  listRehearsals,
  listShapeFindings,
  listShapeProposals,
  recordRehearsal,
  settleShapeFinding,
  upsertShapeAttachment,
  type DbReader,
  type ShapeProposalRow,
  type WriteContext,
} from '@10db/db';
import type { z } from 'zod';
import { appendRevision } from '../plan-record';

// Shape spec §7. Reviewers report findings under an effort or one of its tasks; the rehearsal reads
// each task as its implementer and reports the questions it would have to ask. The session resolves a
// finding by amending the plan, or the builder dismisses it. A rehearsal marks a task read only on its
// closing report, and only at the hash the daemon listed the task at.

/** One proposed task as the rehearsal reads it: where it is, what it says, and the hash it has now. */
export interface RehearsalTask {
  readonly proposalId: ShapeProposalId;
  readonly effortKey: string;
  readonly taskKey: string;
  readonly title: string;
  readonly hash: string;
  /** The task in full, as the rehearsal note hands it to the reviewer. */
  readonly text: string;
}

const efforts = (db: DbReader, shapeId: ShapeId): ShapeProposalRow[] =>
  listShapeProposals(db, shapeId).filter(
    (row) =>
      row.state === ShapeProposalState.Pending &&
      (row.kind === ShapeProposalKind.Goal || row.kind === ShapeProposalKind.Task),
  );

function renderTask(task: {
  title: string;
  description?: string | undefined;
  criteria?: readonly string[] | undefined;
  acceptanceCriteria?: readonly string[] | undefined;
  areas: readonly string[];
  dependsOn?: readonly string[] | undefined;
  why?: string | undefined;
}): string {
  const criteria = task.criteria ?? task.acceptanceCriteria ?? [];
  return [
    `Title: ${task.title}`,
    task.description ? `Description: ${task.description}` : '',
    task.why ? `Why: ${task.why}` : '',
    criteria.length > 0 ? `Acceptance criteria:\n${criteria.map((c) => `- ${c}`).join('\n')}` : '',
    `Areas: ${task.areas.join(', ')}`,
    task.dependsOn && task.dependsOn.length > 0 ? `Depends on: ${task.dependsOn.join(', ')}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Every task of every pending goal, loose task and addition, with the hash it has now. */
export function rehearsalTasks(db: DbReader, shapeId: ShapeId): RehearsalTask[] {
  return efforts(db, shapeId).flatMap((row): RehearsalTask[] => {
    if (row.kind === ShapeProposalKind.Goal) {
      const goal = ShapeProposalBody.goal.parse(row.body);
      return goal.tasks.flatMap((t) => {
        const hash = row.taskHashes[t.key]?.hash;
        return hash === undefined
          ? []
          : [
              {
                proposalId: row.id,
                effortKey: row.key,
                taskKey: t.key,
                title: t.title,
                hash,
                text: renderTask({
                  title: t.title,
                  description: t.description,
                  why: t.why,
                  criteria: t.criteria,
                  areas: t.areas,
                  dependsOn: [...t.depends_on, ...t.dependsOnOutside],
                }),
              },
            ];
      });
    }
    const task = ShapeProposalBody.task.parse(row.body);
    const hash = row.taskHashes[row.key]?.hash;
    return hash === undefined
      ? []
      : [
          {
            proposalId: row.id,
            effortKey: row.key,
            taskKey: row.key,
            title: task.title,
            hash,
            text: renderTask(task),
          },
        ];
  });
}

/** The tasks with no mark at their current hash; narrowed to some proposals when the builder chose them. */
export function unrehearsedTasks(
  db: DbReader,
  shapeId: ShapeId,
  proposalIds?: readonly ShapeProposalId[],
): RehearsalTask[] {
  const marked = new Set(listRehearsals(db, shapeId).map((m) => `${m.taskKey}\0${m.hash}`));
  return rehearsalTasks(db, shapeId).filter(
    (t) =>
      !marked.has(`${t.taskKey}\0${t.hash}`) &&
      (proposalIds === undefined || proposalIds.includes(t.proposalId)),
  );
}

// --- The tools ----------------------------------------------------------------------------------

const line = (ctx: WriteContext, shapeId: ShapeId, body: string): void => {
  insertShapeMessage(ctx, shapeId, {
    author: ShapeMessageAuthor.Claude,
    kind: ShapeMessageKind.Tool,
    body,
  });
};

function effortOf(ctx: WriteContext, shapeId: ShapeId, effortKey: string): ShapeProposalRow {
  const row = efforts(ctx.tx, shapeId).find((r) => r.key === effortKey);
  if (row === undefined)
    throw new InvalidError(`There is no effort with the key ${effortKey} in the plan`);
  return row;
}

/** The task keys of an effort: a goal's own, or a loose task's single key. */
function taskKeysOf(row: ShapeProposalRow): string[] {
  return row.kind === ShapeProposalKind.Goal
    ? ShapeProposalBody.goal.parse(row.body).tasks.map((t) => t.key)
    : [row.key];
}

/**
 * The tasks of a row that a builder's edit touched, whose open rehearsal questions it answers (§7).
 * A goal's task fields are named `tasks.<key>.<field>`; a loose task's own fields touch the task,
 * except `ceremony`, which isn't what the implementer reads.
 */
export function editedTaskKeys(
  row: ShapeProposalRow,
  fields: Readonly<Record<string, unknown>>,
): string[] {
  const names = Object.keys(fields);
  if (row.kind === ShapeProposalKind.Task)
    return names.some((f) => f !== 'ceremony') ? [row.key] : [];
  if (row.kind !== ShapeProposalKind.Goal) return [];
  const keys = taskKeysOf(row);
  if (names.includes('tasks')) return keys;
  const touched = names.flatMap((f) => /^tasks\.([^.]+)\./.exec(f)?.[1] ?? []);
  return keys.filter((k) => touched.includes(k));
}

export type ReportFindingInput = z.output<(typeof ShapeToolInputs)['report_finding']>;

export type ReportOutcome =
  | { readonly recorded: true; readonly findingId?: ShapeFindingId; readonly marked?: true }
  | { readonly discarded: true; readonly why: string };

/**
 * A reviewer's report. The daemon stamps the reviewer (from the subagent's type, by the PreToolUse
 * hook) and the hash; a rehearsal's report at a hash the task no longer has is discarded.
 */
export function reportFinding(
  ctx: WriteContext,
  shapeId: ShapeId,
  input: ReportFindingInput,
): ReportOutcome {
  const reviewer = input.reviewer;
  if (reviewer === undefined)
    throw new InvalidError('Only a reviewer reports a finding; the main session cannot.');
  const effort = effortOf(ctx, shapeId, input.effortKey);
  const taskKeys = taskKeysOf(effort);
  const round = getShape(ctx.tx, shapeId).round;
  const report = input.finding;

  if (reviewer !== ShapeReviewer.Rehearsal) {
    if (report.kind === 'question')
      throw new InvalidError(`A ${reviewer} reviewer reports findings, not questions.`);
    if (input.taskKey !== undefined && !taskKeys.includes(input.taskKey))
      throw new InvalidError(`${input.effortKey} has no task ${input.taskKey}`);
    if (report.kind === 'none') {
      line(ctx, shapeId, `report_finding · ${reviewer} · ${input.effortKey} · nothing to report`);
      return { recorded: true };
    }
    const row = insertShapeFinding(ctx, {
      shapeId,
      effortKey: input.effortKey,
      taskKey: input.taskKey ?? null,
      reviewer,
      kind: ShapeFindingKind.Finding,
      severity: report.severity,
      text: report.text,
      round,
      taskHash:
        input.taskKey === undefined ? null : (effort.taskHashes[input.taskKey]?.hash ?? null),
    });
    line(
      ctx,
      shapeId,
      `report_finding · ${reviewer} · ${report.severity} · ${input.effortKey} · ${report.text}`,
    );
    return { recorded: true, findingId: row.id };
  }

  // The rehearsal: one task, at the hash the note listed it at.
  const taskKey =
    input.taskKey ?? (effort.kind === ShapeProposalKind.Task ? effort.key : undefined);
  if (taskKey === undefined)
    throw new InvalidError('A rehearsal names the task it read (taskKey).');
  if (!taskKeys.includes(taskKey))
    throw new InvalidError(`${input.effortKey} has no task ${taskKey}`);
  if (input.taskHash === undefined)
    throw new InvalidError('A rehearsal passes the hash it read (taskHash).');
  if (report.kind === 'finding')
    throw new InvalidError(
      'The rehearsal reports questions, or none; findings are for the scope and engineering reviewers.',
    );
  const current = effort.taskHashes[taskKey]?.hash;
  if (current !== input.taskHash) {
    line(ctx, shapeId, `report_finding · rehearsal · ${taskKey} · discarded, the task changed`);
    return {
      discarded: true,
      why: `${taskKey} changed while you read it; this report is for an earlier version and was not kept.`,
    };
  }
  const askedAt = (): ReturnType<typeof listShapeFindings> =>
    listShapeFindings(ctx.tx, shapeId).filter(
      (f) =>
        f.reviewer === ShapeReviewer.Rehearsal &&
        f.kind === ShapeFindingKind.Question &&
        f.taskKey === taskKey &&
        f.taskHash === input.taskHash,
    );
  if (report.kind === 'question') {
    if (!askedAt().some((f) => f.text === report.text)) {
      insertShapeFinding(ctx, {
        shapeId,
        effortKey: input.effortKey,
        taskKey,
        reviewer,
        kind: ShapeFindingKind.Question,
        severity: null,
        text: report.text,
        round,
        taskHash: input.taskHash,
      });
    }
    line(ctx, shapeId, `report_finding · rehearsal · ${taskKey} · ${report.text}`);
  } else line(ctx, shapeId, `report_finding · rehearsal · ${taskKey} · nothing to ask`);
  // `none` closes the rehearsal, as does a question marked final.
  if (report.kind === 'none' || input.final === true) {
    recordRehearsal(ctx, {
      shapeId,
      taskKey,
      hash: input.taskHash,
      round,
      questions: askedAt().length,
    });
    return { recorded: true, marked: true };
  }
  return { recorded: true };
}

/** The session resolves a finding once a `propose_plan` call has answered it. */
export function resolveFinding(
  ctx: WriteContext,
  shapeId: ShapeId,
  input: { readonly findingId: ShapeFindingId; readonly how: string },
): { readonly resolved: true } {
  const finding = getShapeFinding(ctx.tx, input.findingId);
  if (finding.shapeId !== shapeId) throw new NotFoundError('shape finding', input.findingId);
  settleShapeFinding(ctx, input.findingId, ShapeFindingState.Resolved, input.how);
  line(ctx, shapeId, `resolve_finding · ${finding.effortKey} · ${input.how}`);
  return { resolved: true };
}

/** The builder dismisses a finding, with a one-line reason or none. */
export function dismissFinding(
  ctx: WriteContext,
  shapeId: ShapeId,
  findingId: ShapeFindingId,
  how: string,
): void {
  const finding = getShapeFinding(ctx.tx, findingId);
  if (finding.shapeId !== shapeId) throw new NotFoundError('shape finding', findingId);
  settleShapeFinding(ctx, findingId, ShapeFindingState.Dismissed, how);
}

/** An effort's spec: kept as the effort's attachment, replacing an earlier one. */
export function writeSpec(
  ctx: WriteContext,
  shapeId: ShapeId,
  input: { readonly effortKey: string; readonly markdown: string },
): { readonly written: true } {
  effortOf(ctx, shapeId, input.effortKey);
  const specId = upsertShapeAttachment(ctx, {
    shapeId,
    kind: 'spec',
    key: input.effortKey,
    body: input.markdown,
  });
  // Every text the spec has had is kept; the same text again adds nothing.
  appendRevision(ctx, specId, input.markdown, {
    note: null,
    author: null,
    bundleNumber: null,
    authoredAt: null,
  });
  line(ctx, shapeId, `write_spec · ${input.effortKey}`);
  return { written: true };
}
