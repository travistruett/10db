import {
  PlanEntryBody,
  PlanEntryState,
  PlanItemDropped,
  ShapeFindingState,
  ShapeProposalBody,
  ShapeProposalState,
  type PlanContext,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  getAttachmentRevisionById,
  getDocumentAttachment,
  getGoal,
  getShape,
  getShapeEntry,
  getTask,
  getTaskContext,
  getWorkstreamRow,
  listAnchorChecks,
  listShapeFindings,
  listShapeProposals,
  type DbReader,
} from '@10db/db';
import { CHARS_PER_TOKEN } from '../knowledge';
import { anchorCheckDto } from './check-dto';
import { planItemLine, type PlanItem } from './plan-lines';
import { findSection, sectionText } from './sections';

// What a lane's brief carries of its task's Plan: the section it was made from and the shared ones,
// whole, then the items it cites as far as their own budget goes.

/** The budget, in estimated tokens, for the items a task cites; its sections never count. */
export const PLAN_CONTEXT_BUDGET_TOKENS = 6000;

const ORDER: Record<PlanItem['group'], number> = {
  decision: 0,
  name: 1,
  fact: 2,
  finding: 3,
  intent: 4,
};

/**
 * Keeps items in kind order (decisions, names, facts and experiments, open findings, intent) while
 * they fit; an item that doesn't fit is named in `notIncluded` and the next is tried.
 */
export function packPlanItems(
  items: readonly PlanItem[],
  budgetTokens: number,
): { kept: PlanItem[]; notIncluded: string[]; used: number } {
  const ordered = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => ORDER[a.item.group] - ORDER[b.item.group] || a.i - b.i)
    .map((x) => x.item);
  const kept: PlanItem[] = [];
  const notIncluded: string[] = [];
  let used = 0;
  for (const item of ordered) {
    const cost = Math.ceil(planItemLine(item).length / CHARS_PER_TOKEN);
    if (used + cost <= budgetTokens) {
      kept.push(item);
      used += cost;
    } else notIncluded.push(item.item.key);
  }
  return { kept, notIncluded, used };
}

/** A decision proposal the builder dropped or a later plan replaced no longer stands. */
const DROPPED_PROPOSAL: Partial<Record<ShapeProposalState, PlanItemDropped>> = {
  [ShapeProposalState.Rejected]: PlanItemDropped.Rejected,
  [ShapeProposalState.Superseded]: PlanItemDropped.Superseded,
};

/** A fact's one line: its claim, what an experiment shows, or the cost in brief. */
function factLine(body: PlanEntryBody['fact'] | PlanEntryBody['experiment']): string {
  if ('shows' in body) return body.shows;
  if ('claim' in body) return body.claim;
  const tokens = body.rows.reduce((sum, r) => sum + r.tokens, 0);
  return body.note ?? `cost: ${String(tokens)} tokens over ${String(body.rows.length)} phases`;
}

/**
 * The Plan block of a workstream's brief, or null when its task was not made from a Plan. Checks count
 * only when this workstream made them at `base` (the row's `baseHead` unless the runner passes the
 * base it read) for the cited fact's current version.
 */
export function buildPlanContext(
  db: DbReader,
  workstream: WorkstreamDto,
  opts: { readonly base?: string; readonly budgetTokens?: number } = {},
): PlanContext | null {
  const task = getTask(db, workstream.taskId);
  const context = getTaskContext(db, task.id);
  if (context === undefined) return null;
  const revision = getAttachmentRevisionById(db, context.revisionId);
  const document = revision ? getDocumentAttachment(db, revision.attachmentId) : undefined;
  if (revision === undefined || document === undefined) return null;
  const shape = getShape(db, context.shapeId);
  const docKey = document.docKey ?? document.key;
  const textOf = (slug: string) => {
    const entry = findSection(revision.sections, slug);
    return { ref: `${docKey}#${slug}`, text: entry ? sectionText(revision.body, entry) : '' };
  };

  const base = opts.base ?? getWorkstreamRow(db, workstream.id).baseHead;
  const checks = base === null ? [] : listAnchorChecks(db, workstream.id, base);
  const decisions = new Map(
    listShapeProposals(db, shape.id)
      .filter((r) => r.kind === 'decision')
      .map((r) => [r.key, { record: ShapeProposalBody.decision.parse(r.body), state: r.state }]),
  );

  const items: PlanItem[] = [];
  for (const key of context.cites) {
    const decision = decisions.get(key);
    if (decision) {
      items.push({
        group: 'decision',
        item: {
          key,
          choice: decision.record.choice,
          rationale: decision.record.rationale,
          lasting: decision.record.lasting,
          dropped: DROPPED_PROPOSAL[decision.state] ?? null,
        },
      });
      continue;
    }
    const entry = getShapeEntry(db, shape.id, key);
    if (!entry) continue;
    const version = entry.version;
    const superseded = entry.state === PlanEntryState.Superseded;
    const dropped = superseded ? PlanItemDropped.Superseded : null;
    switch (entry.kind) {
      case 'intent': {
        const body = PlanEntryBody.intent.parse(entry.body);
        items.push({
          group: 'intent',
          item: { key, version, quote: body.quote, speaker: body.speaker, dropped },
        });
        break;
      }
      case 'name': {
        const body = PlanEntryBody.name.parse(entry.body);
        items.push({
          group: 'name',
          item: { key, version, name: body.name, definition: body.definition, dropped },
        });
        break;
      }
      case 'fact':
      case 'experiment':
        items.push({
          group: 'fact',
          item: {
            key,
            version,
            kind: entry.kind,
            line:
              entry.kind === 'fact'
                ? factLine(PlanEntryBody.fact.parse(entry.body))
                : factLine(PlanEntryBody.experiment.parse(entry.body)),
            anchors: entry.anchors,
            // A superseded fact's anchors are never checked, so none are carried as checked.
            checks: superseded
              ? []
              : checks
                  .filter((c) => c.entryKey === key && c.entryVersion === version)
                  .map(anchorCheckDto),
            dropped,
          },
        });
        break;
    }
  }
  // Only an imported finding has a key `get_plan_entry` can read it back by, if the budget leaves it out.
  for (const f of listShapeFindings(db, shape.id)) {
    if (f.bundleKey === null) continue;
    if (f.state !== ShapeFindingState.Open || f.section !== context.section) continue;
    const at = f.revisionId === null ? undefined : getAttachmentRevisionById(db, f.revisionId);
    if (at?.attachmentId !== document.id) continue;
    items.push({
      group: 'finding',
      item: {
        key: f.bundleKey,
        severity: f.severityText ?? f.severity ?? f.kind,
        text: f.text,
      },
    });
  }

  const budget = opts.budgetTokens ?? PLAN_CONTEXT_BUDGET_TOKENS;
  const { kept, notIncluded, used } = packPlanItems(items, budget);
  const goal = task.goalId ? getGoal(db, task.goalId) : null;
  const decisionsKept: PlanContext['decisions'] = [];
  const names: PlanContext['names'] = [];
  const facts: PlanContext['facts'] = [];
  const findings: PlanContext['findings'] = [];
  const intent: PlanContext['intent'] = [];
  for (const entry of kept)
    switch (entry.group) {
      case 'decision':
        decisionsKept.push(entry.item);
        break;
      case 'name':
        names.push(entry.item);
        break;
      case 'fact':
        facts.push(entry.item);
        break;
      case 'finding':
        findings.push(entry.item);
        break;
      case 'intent':
        intent.push(entry.item);
        break;
    }
  return {
    shapeId: shape.id,
    revisionId: revision.id,
    title: shape.title,
    document: { key: docKey, title: document.title ?? docKey, revision: revision.number },
    goal: goal ? { objective: goal.objective, why: goal.caresMost ?? task.why } : null,
    section: textOf(context.section),
    shared: context.shared.map(textOf),
    decisions: decisionsKept,
    names,
    facts,
    findings,
    intent,
    notIncluded,
    budget,
    used,
  };
}
