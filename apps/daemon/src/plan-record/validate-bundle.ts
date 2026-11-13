import type {
  PlanBundle,
  PlanDocumentKind,
  PlanImportIssue,
  PlanRef,
  ProjectId,
  ShapeId,
} from '@10db/contracts';
import { sha256Of } from './revisions';
import { indexSections } from './sections';

// Every rule a bundle must keep before anything is written, each broken one its own issue, so the
// builder fixes a bundle in one go. Pure: what the project and an earlier import stored comes in.

/** The most tasks one imported goal may hold. */
export const IMPORT_MAX_TASKS_PER_GOAL = 100;

/** What a key names in a Plan's record. */
export type RecordKeyKind =
  | 'intent'
  | 'fact'
  | 'experiment'
  | 'name'
  | 'document'
  | 'decision'
  | 'finding'
  | 'question'
  | 'goal'
  | 'task'
  | 'landing';

/** What an earlier import of the same bundle id stored, for the rules a re-import must keep. */
export interface StoredRecord {
  readonly shapeId: ShapeId;
  /** Per document key: its kind, the effort it is the spec of, and each bundle number's hash. */
  readonly documents: ReadonlyMap<
    string,
    {
      readonly kind: PlanDocumentKind | 'eval';
      readonly effort: string | null;
      readonly revisions: ReadonlyMap<number, string>;
    }
  >;
  /** Every key the record holds, with what it names. */
  readonly kinds: ReadonlyMap<string, RecordKeyKind>;
}

const ARTICLE: Record<RecordKeyKind, string> = {
  intent: 'an intent',
  fact: 'a fact',
  experiment: 'an experiment',
  name: 'a name',
  document: 'a document',
  decision: 'a decision',
  finding: 'a finding',
  question: 'a question',
  goal: 'a goal',
  task: 'a task',
  landing: 'a landing',
};

/** Every key of a bundle with what it names, in the bundle's order. */
export function bundleKeys(bundle: PlanBundle): [string, RecordKeyKind][] {
  return [
    ...bundle.intent.map((i): [string, RecordKeyKind] => [i.key, 'intent']),
    ...bundle.documents.map((d): [string, RecordKeyKind] => [d.key, 'document']),
    ...bundle.entries.map((e): [string, RecordKeyKind] => [e.key, e.kind]),
    ...bundle.decisions.map((d): [string, RecordKeyKind] => [d.key, 'decision']),
    ...bundle.findings.map((f): [string, RecordKeyKind] => [f.key, 'finding']),
    ...bundle.questions.map((q): [string, RecordKeyKind] => [q.key, 'question']),
    ...bundle.goals.flatMap((g): [string, RecordKeyKind][] => [
      [g.key, 'goal'],
      ...g.tasks.map((t): [string, RecordKeyKind] => [t.key, 'task']),
    ]),
    ...bundle.tasks.map((t): [string, RecordKeyKind] => [t.key, 'task']),
    ...bundle.landings.map((l): [string, RecordKeyKind] => [l.key, 'landing']),
  ];
}

/** The section slugs of each bundle revision, by `doc#number`. */
function slugsByRevision(bodies: ReadonlyMap<string, string>): Map<string, Set<string>> {
  return new Map(
    [...bodies].map(([ref, body]) => [ref, new Set(indexSections(body).map((s) => s.slug))]),
  );
}

/**
 * A dependency cycle among the bundle's tasks, as its keys in order, or null. Iterative, so a long
 * chain in an outside bundle can't exhaust the stack.
 */
function cycleOf(edges: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, 'open' | 'done'>();
  for (const root of edges.keys()) {
    if (state.has(root)) continue;
    const path: string[] = [root];
    const next: number[] = [0];
    state.set(root, 'open');
    while (path.length > 0) {
      const at = path.length - 1;
      const key = path[at] ?? '';
      const deps = edges.get(key) ?? [];
      const i = next[at] ?? 0;
      if (i >= deps.length) {
        state.set(key, 'done');
        path.pop();
        next.pop();
        continue;
      }
      next[at] = i + 1;
      const dep = deps[i] ?? '';
      if (!edges.has(dep) || state.get(dep) === 'done') continue;
      if (state.get(dep) === 'open') return [...path.slice(path.indexOf(dep)), dep];
      state.set(dep, 'open');
      path.push(dep);
      next.push(0);
    }
  }
  return null;
}

export function validateBundle(input: {
  readonly bundle: PlanBundle;
  readonly bodies: ReadonlyMap<string, string>;
  readonly projectId: ProjectId;
  readonly areaNames: ReadonlySet<string>;
  readonly stored: StoredRecord | null;
}): PlanImportIssue[] {
  const { bundle, bodies, stored } = input;
  const issues: PlanImportIssue[] = [];
  const say = (path: string, message: string): void => {
    issues.push({ path, message });
  };

  if (bundle.projectId !== input.projectId)
    say('projectId', `The bundle names another project (${bundle.projectId})`);

  const keys = bundleKeys(bundle);
  const seen = new Map<string, number>();
  for (const [key] of keys) seen.set(key, (seen.get(key) ?? 0) + 1);
  for (const [key, count] of seen)
    if (count > 1) say(`Key ${key}`, `${key} is used more than once in the bundle`);
  if (stored)
    for (const [key, kind] of keys) {
      const was = stored.kinds.get(key);
      if (was !== undefined && was !== kind)
        say(`Key ${key}`, `${key} is ${ARTICLE[kind]} here but is stored as ${ARTICLE[was]}`);
    }

  // Documents and their revisions.
  const documents = new Map(bundle.documents.map((d) => [d.key, d]));
  const goalKeys = new Set(bundle.goals.map((g) => g.key));
  const specOf = new Map<string, string>();
  for (const document of bundle.documents) {
    const at = `Document ${document.key}`;
    const numbers = document.revisions.map((r) => r.number);
    if (numbers.some((n, i) => i > 0 && n <= (numbers[i - 1] ?? 0)))
      say(`${at}, revisions`, 'Revision numbers must increase');
    const was = stored?.documents.get(document.key);
    if (was && was.kind !== document.kind)
      say(`${at}, kind`, `A document keeps its kind: ${document.key} is stored as ${was.kind}`);
    if (was) {
      const next = Math.max(...was.revisions.keys(), ...numbers) + 1;
      for (const revision of document.revisions) {
        const hash = was.revisions.get(revision.number);
        const body = bodies.get(`${document.key}#${String(revision.number)}`);
        if (hash !== undefined && body !== undefined && sha256Of(body) !== hash)
          say(
            `${at}, revision ${String(revision.number)}`,
            `revision ${String(revision.number)} of ${document.key} changed; add it as revision ${String(next)}`,
          );
      }
    }
    if (document.effort !== undefined) {
      if (!goalKeys.has(document.effort))
        say(`${at}, effort: ${document.effort}`, 'names no goal of the bundle');
      if (document.kind === 'spec') {
        const other = specOf.get(document.effort);
        if (other !== undefined)
          say(`${at}, effort`, `${other} and ${document.key} are two specs of ${document.effort}`);
        else specOf.set(document.effort, document.key);
      }
    }
  }
  if (stored)
    for (const [effort, key] of specOf)
      for (const [storedKey, doc] of stored.documents)
        if (doc.kind === 'spec' && doc.effort === effort && storedKey !== key)
          say(`Document ${key}, effort`, `${storedKey} is stored as the spec of ${effort}`);

  const slugs = slugsByRevision(bodies);
  const checkRef = (at: string, ref: PlanRef): void => {
    const document = documents.get(ref.document);
    if (!document) {
      say(`${at}, planRef`, `No document ${ref.document} in the bundle`);
      return;
    }
    const sections = slugs.get(`${ref.document}#${String(ref.revision)}`);
    if (!document.revisions.some((r) => r.number === ref.revision) || sections === undefined) {
      say(`${at}, planRef`, `${ref.document} has no revision ${String(ref.revision)}`);
      return;
    }
    for (const slug of [ref.section, ...ref.shared])
      if (!sections.has(slug))
        say(
          `${at}, planRef`,
          `${ref.document}#${slug} is not in revision ${String(ref.revision)} of ${ref.document}`,
        );
  };

  // Tasks: references, areas, dependencies.
  const citeable = new Set([
    ...bundle.intent.map((i) => i.key),
    ...bundle.entries.map((e) => e.key),
    ...bundle.decisions.map((d) => d.key),
  ]);
  const tasks = [...bundle.goals.flatMap((g) => g.tasks), ...bundle.tasks];
  const taskKeys = new Set(tasks.map((t) => t.key));
  for (const task of tasks) {
    const at = `Task ${task.key}`;
    if (task.planRef) checkRef(at, task.planRef);
    for (const cite of task.cites)
      if (!citeable.has(cite)) say(`${at}, cites: ${cite}`, 'is no intent, entry or decision');
    for (const area of task.areas)
      if (!input.areaNames.has(area)) say(`${at}, areas: ${area}`, 'is not an area of the project');
    for (const dep of task.dependsOn)
      if (!taskKeys.has(dep)) say(`${at}, depends on: ${dep}`, 'is no task of the bundle');
  }
  const cycle = cycleOf(new Map(tasks.map((t) => [t.key, t.dependsOn])));
  if (cycle) say('Tasks, depends on', `A dependency cycle: ${cycle.join(' → ')}`);
  for (const goal of bundle.goals)
    if (goal.tasks.length > IMPORT_MAX_TASKS_PER_GOAL)
      say(
        `Goal ${goal.key}, tasks`,
        `${goal.key} has ${String(goal.tasks.length)} tasks; a goal holds at most ${String(IMPORT_MAX_TASKS_PER_GOAL)}`,
      );

  // Findings.
  for (const finding of bundle.findings) {
    const at = `Finding ${finding.key}`;
    const document = documents.get(finding.document);
    if (!document) {
      say(`${at}, document`, `No document ${finding.document} in the bundle`);
      continue;
    }
    const sections = slugs.get(`${finding.document}#${String(finding.revision)}`);
    if (sections === undefined) {
      say(`${at}, revision`, `${finding.document} has no revision ${String(finding.revision)}`);
      continue;
    }
    if (finding.section !== undefined && !sections.has(finding.section))
      say(
        `${at}, section`,
        `${finding.document}#${finding.section} is not in revision ${String(finding.revision)}`,
      );
  }

  // Landings and questions.
  const landed = new Map<string, string>();
  for (const landing of bundle.landings)
    for (const key of landing.keys) {
      if (!taskKeys.has(key)) {
        say(`Landing ${landing.key}, keys: ${key}`, 'is no task of the bundle');
        continue;
      }
      const other = landed.get(key);
      if (other !== undefined)
        say(`Landing ${landing.key}`, `${key} is in two landings (${other}, ${landing.key})`);
      else landed.set(key, landing.key);
    }
  for (const question of bundle.questions)
    if (
      question.about !== undefined &&
      !goalKeys.has(question.about) &&
      !taskKeys.has(question.about)
    )
      say(`Question ${question.key}, about: ${question.about}`, 'is no goal or task of the bundle');

  return issues;
}
