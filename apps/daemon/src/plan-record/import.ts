import {
  ConflictError,
  EventType,
  PlanEntryKind,
  PlanEntryState,
  ShapeFindingReviewer,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeOrigin,
  ShapeProposalBody,
  ShapeProposalState,
  ShapeState,
  type BundleTask,
  type GoalId,
  type PlanBundle,
  type PlanImportChanges,
  type PlanImportResult,
  type PlanRef,
  type ProjectId,
  type ShapeId,
  type ShapeProposalKind,
} from '@10db/contracts';
import {
  findDocument,
  getAttachmentRevision,
  getShapeEntry,
  insertDocumentAttachment,
  insertShape,
  insertShapeMessage,
  insertShapeProposal,
  listShapeProposals,
  patchShape,
  patchShapeProposal,
  shapeEntryContent,
  upsertImportedFinding,
  upsertShapeEntry,
  type Json,
  type NewShapeEntry,
  type WriteContext,
} from '@10db/db';
import {
  canonicalJson,
  findingContent,
  loadStoredRecord,
  proposalBodyText,
  type ConvertedTask,
  type StoredPlan,
} from './lookup';
import { appendRevision } from './revisions';

// Importing a bundle into one Plan. `planImportChanges` says what an import would add, change and
// leave alone; a dry run answers it, and `importBundle` writes exactly it in the caller's transaction.
// A re-import never removes anything, never edits what Convert made, and keeps what the builder pinned.

const refOf = (document: string, number: number): string => `${document}#${String(number)}`;

/** How each bundle revision number maps to the record's own: stored ones as stored, new ones next. */
type Numbering = ReadonlyMap<string, ReadonlyMap<number, number>>;

function numberingOf(stored: StoredPlan | null, bundle: PlanBundle): Numbering {
  return new Map(
    bundle.documents.map((document) => {
      const was = stored?.numbering.get(document.key);
      const out = new Map(was?.byBundle ?? []);
      let next = (was?.latest ?? 0) + 1;
      for (const r of document.revisions)
        if (!out.has(r.number)) {
          out.set(r.number, next);
          next += 1;
        }
      return [document.key, out];
    }),
  );
}

/** A bundle's ref, in the record's revision numbers. */
function translated(ref: PlanRef, numbering: Numbering): PlanRef {
  return { ...ref, revision: numbering.get(ref.document)?.get(ref.revision) ?? ref.revision };
}

// --- Entries ------------------------------------------------------------------------------------

type EntryInput = Omit<NewShapeEntry, 'shapeId'>;

/** The first line of a quote, cut at 120 characters. */
function quoteTitle(quote: string): string {
  const line = quote.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function entryInputs(bundle: PlanBundle): EntryInput[] {
  return [
    ...bundle.intent.map((i): EntryInput => ({
      key: i.key,
      kind: PlanEntryKind.Intent,
      title: i.title ?? quoteTitle(i.quote),
      body: { quote: i.quote, speaker: i.speaker, saidAt: i.saidAt },
      anchors: [],
      sources: [],
      verified: true,
      checkedAt: null,
      state: PlanEntryState.Current,
    })),
    ...bundle.entries.map((e): EntryInput => ({
      key: e.key,
      kind: e.kind,
      title: e.title,
      body: e.body,
      anchors: e.anchors,
      sources: e.sources,
      verified: e.verified,
      checkedAt: e.checkedAt,
      state: PlanEntryState.Current,
    })),
  ];
}

// --- Findings -----------------------------------------------------------------------------------

function findingInputs(bundle: PlanBundle) {
  const effortOf = new Map(bundle.documents.map((d) => [d.key, d.effort ?? d.key]));
  return bundle.findings.map((f) => ({
    finding: f,
    effortKey: effortOf.get(f.document) ?? f.document,
    content: findingContent({
      document: f.document,
      revision: f.revision,
      section: f.section ?? null,
      effortKey: effortOf.get(f.document) ?? f.document,
      reviewerName: f.reviewer,
      round: f.round,
      kind: f.kind,
      severity: f.severity,
      severityText: f.severityText ?? null,
      text: f.text,
      state: f.state,
      outcomeText: f.outcomeText ?? null,
      how: f.how ?? null,
      howDetail: f.howDetail ?? null,
    }),
  }));
}

// --- Proposals ----------------------------------------------------------------------------------

/** A proposal an import writes: a new row, or a pending one replaced, or a tombstone revived. */
interface ProposalWrite {
  readonly key: string;
  readonly kind: ShapeProposalKind;
  readonly body: Json;
}

interface ProposalPlan {
  readonly writes: ProposalWrite[];
  readonly added: string[];
  readonly replaced: string[];
  readonly keptPinned: string[];
  readonly changeTasks: string[];
  readonly additions: string[];
  readonly leftAlone: { key: string; why: string }[];
}

/** A JSON value from a parsed proposal body: zod answered plain JSON for JSON input. */
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

function taskFields(task: BundleTask, numbering: Numbering) {
  return {
    key: task.key,
    title: task.title,
    headline: task.headline,
    why: task.why,
    description: task.description,
    criteria: task.criteria,
    areas: task.areas,
    size: task.size,
    ...(task.planRef ? { planRef: translated(task.planRef, numbering) } : {}),
    cites: task.cites,
  };
}

/** Every proposal the bundle states, as it would be written into a Plan that converted nothing. */
function proposalDrafts(bundle: PlanBundle, numbering: Numbering): Map<string, ProposalWrite> {
  const out = new Map<string, ProposalWrite>();
  const put = (key: string, kind: ShapeProposalKind, body: unknown): void => {
    out.set(key, { key, kind, body: asJson(body) });
  };
  for (const goal of bundle.goals) {
    const inside = new Set(goal.tasks.map((t) => t.key));
    put(goal.key, 'goal', {
      key: goal.key,
      title: goal.title,
      objective: goal.objective,
      ...(goal.cares_most === undefined ? {} : { cares_most: goal.cares_most }),
      criteria: goal.criteria,
      ceremony: goal.ceremony,
      people: [],
      tasks: goal.tasks.map((t) => ({
        ...taskFields(t, numbering),
        depends_on: t.dependsOn.filter((k) => inside.has(k)),
        dependsOnOutside: t.dependsOn.filter((k) => !inside.has(k)),
        annotations: [],
      })),
    });
  }
  for (const task of bundle.tasks)
    put(task.key, 'task', {
      ...taskFields(task, numbering),
      ceremony: task.ceremony,
      dependsOn: task.dependsOn,
      annotations: [],
    });
  for (const landing of bundle.landings)
    put(landing.key, 'landing', { key: landing.key, title: landing.title, keys: landing.keys });
  for (const d of bundle.decisions)
    put(d.key, 'decision', {
      key: d.key,
      kind: 'decision',
      scope: d.scope,
      ...(d.area === undefined ? {} : { area: d.area }),
      question: d.question,
      choice: d.choice,
      rationale: d.rationale,
      alternatives: d.alternatives,
      ...(d.quote === undefined ? {} : { quote: d.quote }),
      lasting: d.lasting,
      anchors: d.anchors,
      ...(d.decidedAt === undefined ? {} : { decidedAt: d.decidedAt }),
    });
  for (const q of bundle.questions)
    put(q.key, 'question', {
      key: q.key,
      text: q.text,
      for: q.owner ?? 'builder',
      ...(q.about === undefined ? {} : { about: q.about }),
      ...(q.blocks === undefined ? {} : { blocks: q.blocks }),
    });
  return out;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  canonicalJson(a) === canonicalJson(b);

/** What changed in a bundle task since Convert made it: the fields a `change_task` carries. */
function taskChange(
  task: BundleTask,
  was: ConvertedTask,
  numbering: Numbering,
): { body: Record<string, unknown>; dependsOnMoved: boolean } {
  const ref = task.planRef ? translated(task.planRef, numbering) : null;
  const body: Record<string, unknown> = {};
  if (task.title !== was.title) body['title'] = task.title;
  if (task.description !== was.description) body['description'] = task.description;
  if (task.criteria.length > 0 && !sameList(task.criteria, was.acceptanceCriteria))
    body['acceptanceCriteria'] = task.criteria;
  if (!sameList(task.areas, was.areas)) body['areas'] = task.areas;
  // A pin needs a section, so a task without a planRef keeps no cites either.
  if (ref !== null && canonicalJson(ref) !== canonicalJson(was.planRef)) body['planRef'] = ref;
  if (ref !== null && !sameList(task.cites, was.cites)) body['cites'] = task.cites;
  return {
    body,
    dependsOnMoved: !sameList([...task.dependsOn].sort(), [...was.dependsOn].sort()),
  };
}

const WHY_CHANGED_AFTER_CONVERT: Partial<Record<ShapeProposalKind, string>> = {
  decision: 'changed after Convert: supersede it in Knowledge',
  principle: 'changed after Convert: supersede it in Knowledge',
  question: 'changed after Convert: ask it again',
  landing: 'changed after Convert: change the landing on the board',
  goal: 'changed after Convert: edit the goal',
};

function planProposals(
  stored: StoredPlan | null,
  bundle: PlanBundle,
  numbering: Numbering,
): ProposalPlan {
  const plan: ProposalPlan = {
    writes: [],
    added: [],
    replaced: [],
    keptPinned: [],
    changeTasks: [],
    additions: [],
    leftAlone: [],
  };
  /** Writes `write` against what the Plan holds under its key; answers whether it wrote. */
  const offer = (write: ProposalWrite, list: 'added' | 'changeTasks' | 'additions'): void => {
    const held = stored?.proposals.get(write.key);
    if (held === undefined) {
      plan.writes.push(write);
      plan[list].push(write.key);
      return;
    }
    if (held.body === proposalBodyText(write.kind, write.body)) return;
    if (held.state === ShapeProposalState.Pending) {
      if (held.pinned) plan.keptPinned.push(write.key);
      else {
        plan.writes.push(write);
        plan[list === 'added' ? 'replaced' : list].push(write.key);
      }
      return;
    }
    if (write.kind === 'change_task' && held.state === ShapeProposalState.Accepted) {
      // An earlier change was converted; this is a new one against the task as it is now.
      plan.writes.push(write);
      plan.changeTasks.push(write.key);
      return;
    }
    if (held.state === ShapeProposalState.Accepted) {
      const why = WHY_CHANGED_AFTER_CONVERT[held.kind] ?? 'changed after Convert';
      plan.leftAlone.push({ key: write.key, why: `${write.key} ${why}` });
      return;
    }
    plan.leftAlone.push({
      key: write.key,
      why: `${write.key} was dropped or replaced in Plan; propose it there again to bring it back`,
    });
  };

  /** A bundle task Convert already made: its change, or why it is left alone. */
  const converted = (task: BundleTask, was: ConvertedTask): void => {
    const { body, dependsOnMoved } = taskChange(task, was, numbering);
    const fields = Object.keys(body);
    if (dependsOnMoved)
      plan.leftAlone.push({
        key: task.key,
        why: `${task.key}'s dependencies changed after Convert: set them on the board`,
      });
    if (fields.length === 0) return;
    if (was.started) {
      plan.leftAlone.push({
        key: task.key,
        why: `${task.key} has started, so its change (${fields.join(', ')}) is left alone`,
      });
      return;
    }
    offer(
      {
        key: `change:${was.taskId}`,
        kind: 'change_task',
        body: asJson({ taskId: was.taskId, ...body }),
      },
      'changeTasks',
    );
  };

  const drafts = proposalDrafts(bundle, numbering);
  const bundleTaskKeys = new Set([
    ...bundle.goals.flatMap((g) => g.tasks.map((t) => t.key)),
    ...bundle.tasks.map((t) => t.key),
  ]);
  for (const goal of bundle.goals) {
    const draft = drafts.get(goal.key);
    const goalId = stored?.goals.get(goal.key);
    if (draft === undefined) continue;
    if (goalId === undefined) {
      offer(draft, 'added');
      continue;
    }
    // A converted goal: its own fields are the builder's now; its tasks change or are added.
    const held = stored?.proposals.get(goal.key);
    const own = (body: unknown): string => {
      const parsed = ShapeProposalBody.goal.safeParse(body);
      return parsed.success
        ? canonicalJson({ ...parsed.data, tasks: [], sourceMessageIds: undefined })
        : '';
    };
    if (held !== undefined && own(JSON.parse(held.body || 'null')) !== own(draft.body))
      plan.leftAlone.push({
        key: goal.key,
        why: `${goal.key} ${WHY_CHANGED_AFTER_CONVERT.goal ?? ''}`,
      });
    for (const task of goal.tasks) {
      const was = stored?.converted.get(task.key);
      if (was !== undefined) converted(task, was);
      else
        offer(
          {
            key: task.key,
            kind: 'task',
            body: asJson({
              ...taskFields(task, numbering),
              ceremony: goal.ceremony,
              dependsOn: task.dependsOn,
              annotations: [],
              goalId: goalId satisfies GoalId,
            }),
          },
          'additions',
        );
    }
  }
  for (const task of bundle.tasks) {
    const was = stored?.converted.get(task.key);
    const draft = drafts.get(task.key);
    if (was !== undefined) converted(task, was);
    else if (draft !== undefined) offer(draft, 'added');
  }
  for (const [, draft] of drafts)
    if (draft.kind !== 'goal' && draft.kind !== 'task') offer(draft, 'added');
  for (const [key] of stored?.converted ?? [])
    if (!bundleTaskKeys.has(key))
      plan.leftAlone.push({
        key,
        why: `${key} is no longer in the bundle; remove it by hand if it should go`,
      });
  return plan;
}

// --- The whole import ---------------------------------------------------------------------------

/** What an import adds, changes, keeps and leaves alone; nothing is written. */
export function planImportChanges(
  stored: StoredPlan | null,
  bundle: PlanBundle,
  bodies: ReadonlyMap<string, string>,
): PlanImportChanges {
  const numbering = numberingOf(stored, bundle);
  const entries = { added: [] as string[], changed: [] as string[], superseded: [] as string[] };
  const inBundle = new Set<string>();
  for (const e of entryInputs(bundle)) {
    inBundle.add(e.key);
    const was = stored?.entries.get(e.key);
    if (was === undefined) entries.added.push(e.key);
    else if (was.content !== shapeEntryContent(e)) entries.changed.push(e.key);
  }
  for (const [key, was] of stored?.entries ?? [])
    if (!inBundle.has(key) && was.state === PlanEntryState.Current) entries.superseded.push(key);
  const findings = { added: [] as string[], changed: [] as string[] };
  for (const { finding, content } of findingInputs(bundle)) {
    const was = stored?.findings.get(finding.key);
    if (was === undefined) findings.added.push(finding.key);
    else if (was !== content) findings.changed.push(finding.key);
  }
  const proposals = planProposals(stored, bundle, numbering);
  return {
    documents: bundle.documents.flatMap((d) => {
      const added = d.revisions
        .map((r) => r.number)
        .filter((n) => !stored?.numbering.get(d.key)?.byBundle.has(n))
        .filter((n) => bodies.has(refOf(d.key, n)));
      return added.length > 0 ? [{ key: d.key, added }] : [];
    }),
    entries,
    findings,
    proposals: {
      added: proposals.added,
      replaced: proposals.replaced,
      keptPinned: proposals.keptPinned,
      changeTasks: proposals.changeTasks,
      additions: proposals.additions,
      leftAlone: proposals.leftAlone,
    },
  };
}

const writesSomething = (c: PlanImportChanges): boolean =>
  c.documents.length > 0 ||
  c.entries.added.length + c.entries.changed.length + c.entries.superseded.length > 0 ||
  c.findings.added.length + c.findings.changed.length > 0 ||
  c.proposals.added.length +
    c.proposals.replaced.length +
    c.proposals.changeTasks.length +
    c.proposals.additions.length >
    0;

function notice(bundle: PlanBundle, reimport: boolean, changes: PlanImportChanges): string {
  const o = bundle.origin;
  const from = [o.kind, o.session, o.model === undefined ? undefined : `(${o.model})`]
    .filter((p) => p !== undefined)
    .join(' ');
  const n = (count: number, what: string): string => `${String(count)} ${what}`;
  if (!reimport)
    return `Imported from ${from} on ${o.at.slice(0, 10)}: ${[
      n(bundle.documents.length, 'documents'),
      n(bundle.intent.length + bundle.entries.length, 'entries'),
      n(bundle.decisions.length, 'decisions'),
      n(bundle.findings.length, 'findings'),
      n(bundle.questions.length, 'questions'),
      n(bundle.goals.reduce((s, g) => s + g.tasks.length, 0) + bundle.tasks.length, 'tasks'),
    ].join(', ')}.`;
  const p = changes.proposals;
  return `Re-imported from ${from} on ${o.at.slice(0, 10)}: ${[
    n(
      changes.documents.reduce((s, d) => s + d.added.length, 0),
      'revisions added',
    ),
    n(changes.entries.added.length + changes.entries.changed.length, 'entries added or changed'),
    n(changes.entries.superseded.length, 'entries superseded'),
    n(changes.findings.added.length + changes.findings.changed.length, 'findings added or changed'),
    n(
      p.added.length + p.replaced.length + p.changeTasks.length + p.additions.length,
      'proposals added or changed',
    ),
    n(p.keptPinned.length + p.leftAlone.length, 'left alone'),
  ].join(', ')}.`;
}

/**
 * Writes a validated bundle into its Plan, making the Plan on a first import, in the caller's
 * transaction. `changes` must be what `planImportChanges` answers for the Plan as it is now; a Plan
 * that moved since is refused rather than written differently.
 */
export function importBundle(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly bundle: PlanBundle;
    readonly bodies: ReadonlyMap<string, string>;
    readonly changes: PlanImportChanges;
  },
): PlanImportResult {
  const { bundle, bodies } = input;
  const stored = loadStoredRecord(ctx.tx, input.projectId, bundle.id);
  const changes = planImportChanges(stored, bundle, bodies);
  if (canonicalJson(changes) !== canonicalJson(input.changes))
    throw new ConflictError('The Plan changed since this import was checked; import it again');
  if (stored !== null && !writesSomething(changes))
    return { dryRun: false, shapeId: stored.shapeId, created: false, changes };

  const numbering = numberingOf(stored, bundle);
  const proposalPlan = planProposals(stored, bundle, numbering);
  const states =
    proposalPlan.writes.length > 0 ||
    bundle.goals.length + bundle.tasks.length + bundle.decisions.length + bundle.questions.length >
      0;
  const shapeId: ShapeId =
    stored?.shapeId ??
    insertShape(ctx, input.projectId, {
      title: bundle.title,
      origin: ShapeOrigin.ClaudeCode,
      state: states ? ShapeState.Proposed : ShapeState.Listening,
      round: 1,
      bundleId: bundle.id,
      bundleOrigin: bundle.origin,
      importedAt: ctx.now,
    }).id;
  insertShapeMessage(ctx, shapeId, {
    author: ShapeMessageAuthor.Note,
    kind: ShapeMessageKind.Notice,
    body: notice(bundle, stored !== null, changes),
  });

  // Documents and their new revisions.
  const added = new Map(changes.documents.map((d) => [d.key, new Set(d.added)]));
  for (const document of bundle.documents) {
    const wanted = added.get(document.key);
    if (wanted === undefined) continue;
    const attachment =
      findDocument(ctx.tx, shapeId, document.key) ??
      insertDocumentAttachment(ctx, {
        shapeId,
        kind: document.kind,
        key:
          document.kind === 'spec' && document.effort !== undefined
            ? document.effort
            : document.key,
        docKey: document.key,
        title: document.title,
        body: '',
      });
    for (const revision of document.revisions) {
      if (!wanted.has(revision.number)) continue;
      const body = bodies.get(refOf(document.key, revision.number));
      if (body === undefined)
        throw new Error(`No body for ${refOf(document.key, revision.number)}`);
      appendRevision(ctx, attachment.id, body, {
        note: revision.note === '' ? null : revision.note,
        author: revision.author === '' ? null : revision.author,
        bundleNumber: revision.number,
        authoredAt: revision.at,
      });
    }
  }

  // Entries: new and changed ones, then the ones the bundle dropped.
  const changedEntries = new Set([...changes.entries.added, ...changes.entries.changed]);
  for (const entry of entryInputs(bundle))
    if (changedEntries.has(entry.key)) upsertShapeEntry(ctx, { ...entry, shapeId });
  for (const key of changes.entries.superseded) {
    const was = getShapeEntry(ctx.tx, shapeId, key);
    if (was) upsertShapeEntry(ctx, { ...was, shapeId, state: PlanEntryState.Superseded });
  }

  // Findings, on the record's revision of the bundle's number.
  const changedFindings = new Set([...changes.findings.added, ...changes.findings.changed]);
  for (const { finding, effortKey } of findingInputs(bundle)) {
    if (!changedFindings.has(finding.key)) continue;
    const document = findDocument(ctx.tx, shapeId, finding.document);
    const number = numbering.get(finding.document)?.get(finding.revision);
    const revision =
      document && number !== undefined
        ? getAttachmentRevision(ctx.tx, document.id, number)
        : undefined;
    upsertImportedFinding(ctx, {
      shapeId,
      effortKey,
      taskKey: null,
      reviewer: ShapeFindingReviewer.Imported,
      reviewerName: finding.reviewer,
      kind: finding.kind,
      severity: finding.severity,
      severityText: finding.severityText ?? null,
      text: finding.text,
      round: finding.round,
      taskHash: null,
      revisionId: revision?.id ?? null,
      section: finding.section ?? null,
      bundleKey: finding.key,
      state: finding.state,
      outcomeText: finding.outcomeText ?? null,
      how: finding.how ?? null,
      howDetail: finding.howDetail ?? null,
    });
  }

  // Proposals: each body read through its kind's schema before it is written.
  const round = stored?.round ?? 1;
  const rows = new Map(listShapeProposals(ctx.tx, shapeId).map((r) => [r.key, r]));
  for (const write of proposalPlan.writes) {
    const body = asJson(ShapeProposalBody[write.kind].parse(write.body));
    const held = rows.get(write.key);
    if (held)
      patchShapeProposal(ctx, held.id, {
        state: ShapeProposalState.Pending,
        body,
        round,
        ...(held.state === ShapeProposalState.Pending ? {} : { createdRound: round }),
      });
    else
      insertShapeProposal(ctx, {
        shapeId,
        key: write.key,
        kind: write.kind,
        state: ShapeProposalState.Pending,
        round,
        createdRound: round,
        pinned: [],
        body,
        taskHashes: {},
        sourceMessageIds: [],
      });
  }
  if (proposalPlan.writes.length > 0) {
    ctx.emit({
      type: EventType.PlanRecordChanged,
      entityType: 'shape',
      entityId: shapeId,
      data: { projectId: input.projectId, what: 'proposals' },
    });
    if (stored !== null && stored.state !== ShapeState.Proposed)
      patchShape(ctx, shapeId, { state: ShapeState.Proposed });
  }
  return { dryRun: false, shapeId, created: stored === null, changes };
}
