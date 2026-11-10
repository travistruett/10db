import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  findingBody,
  parseFindings,
  passHeldAreas,
  PassNoticeKind,
  StepRole,
  TaskMessageAuthor,
  type AccountId,
  type AreaDef,
  type Finding,
  type PassId,
  type ProjectDto,
  type TaskDto,
  type TaskId,
  type WorkstreamStep,
} from '@10db/contracts';
import {
  clearPassNotice,
  getPass,
  getPassProgress,
  getProject,
  insertSystemNotice,
  listPassTasks,
  listTaskThread,
  setPassNotice,
  setReviewedSha,
  type DbReader,
} from '@10db/db';
import { passReviewPrompt } from '../briefing';
import { classifyPath } from '../guard';
import type { SessionAdapter } from '../sessions';
import { resolveStepPlan } from '../team';
import type { DeliveryContext } from './context';
import {
  cutIn,
  readWhole,
  reviewLeft,
  setReviewLeft,
  type DiffSince,
  type ReviewLeft,
} from './review-left';
import { offerToAgent } from './send-to-agent';

// Workbench spec §8.3, D21: a pass runs no review step per turn. When its pull request is opened, the
// project's review step reads the pull request's diff once, beside the gate, and each finding is
// offered to the page whose file it names (D19: offered, never sent).

/** How long the one review may take: a pull request's diff is longer than a one-line question. */
export const PASS_REVIEW_TIMEOUT_MS = 10 * 60_000;

/** How much of the diff the review reads; a longer one is cut and the review says so. */
const PASS_REVIEW_DIFF_BYTES = 400_000;

/** How the ids of the header's review findings start. */
const FINDING_NOTICE = 'finding:';

/** The header notice that says the last review read only part of its diff. */
export const REVIEW_CUT_NOTICE = 'review-cut';

/** One question to the model, as the adapter takes it. */
type CompletionAsk = Parameters<SessionAdapter['complete']>[0];

/** What the review needs that delivery does not own: the model, and where it asks. */
export interface PassReviewDeps {
  readonly adapter: Pick<SessionAdapter, 'complete'>;
  /** The launch of `model` on the account: what the question runs as (the launcher's `session`). */
  launch(
    accountId: AccountId,
    model: string,
  ): {
    readonly model: string;
    readonly env: Readonly<Record<string, string>>;
    readonly expect: CompletionAsk['account'];
  };
  /** Where each question gets an empty folder of its own to start in. */
  readonly scratchRoot: string;
}

/** A page of the pass and the page areas it holds, as a finding's owner is matched against. */
export interface ReviewPage {
  readonly taskId: TaskId;
  readonly areas: readonly string[];
}

/** One finding and the page it goes to; null for the pass's header. */
export interface FindingTarget {
  readonly finding: Finding;
  readonly taskId: TaskId | null;
}

/** The file a finding's location names, without its line: `src/a.ts:12-14` is `src/a.ts`. */
function fileOf(location: string | null): string | null {
  if (location === null) return null;
  const at = location.lastIndexOf(':');
  const file = at === -1 ? location : location.slice(0, at);
  return file === '' ? null : file;
}

/**
 * Where each finding goes: to the page whose area holds the file it names, else to the pass's header.
 * A file in no page area, or in the areas of two pages, goes to the header, where the builder picks.
 */
export function findingTargets(
  findings: readonly Finding[],
  pages: readonly ReviewPage[],
  areas: readonly AreaDef[],
): FindingTarget[] {
  return findings.map((finding) => {
    const file = fileOf(finding.location);
    if (file === null) return { finding, taskId: null };
    const hit = new Set(classifyPath(file, areas, []).areas);
    const owners = pages.filter((page) => page.areas.some((a) => hit.has(a)));
    const [owner] = owners;
    return { finding, taskId: owners.length === 1 && owner ? owner.taskId : null };
  });
}

/** The review step of the project's flow for a task of the pass, or undefined when it has none. */
function reviewStep(db: DbReader, task: TaskDto): WorkstreamStep | undefined {
  return resolveStepPlan(db, task.id).steps.find((step) => step.role === StepRole.Review);
}

/** Whether the pass's pull request is reviewed at all: its flow has a review step. */
export function passHasReview(db: DbReader, passId: PassId): boolean {
  const [first] = listPassTasks(db, passId);
  return first !== undefined && reviewStep(db, first) !== undefined;
}

function noticeLine(finding: Finding): string {
  const parts = [finding.severity, finding.location, findingBody(finding)].filter(
    (p): p is string => p !== null && p !== '',
  );
  return `Review finding: ${parts.join(' ')}`;
}

/** The `review-cut` notice's words for what is left unread. */
function cutText(sha: string, left: ReviewLeft): string {
  const said = [
    `The diff to ${sha.slice(0, 7)} was longer than the review reads (${String(PASS_REVIEW_DIFF_BYTES / 1000)} kB).`,
  ];
  const n = left.files.length;
  if (n > 0)
    said.push(
      `${String(n)} file${n === 1 ? '' : 's'} not reviewed yet; each later review reads on from where the last one stopped.`,
    );
  if (left.partial.length > 0)
    said.push(
      `Too long to review whole, so the rest of each was not reviewed: ${left.partial.join(', ')}.`,
    );
  return said.join(' ');
}

/**
 * The one review of the pass's tip `sha` (D21), unless it read that tip already and nothing is left
 * unread: the diff from the tip the last review read, else from where the tip leaves `base`, then,
 * with what room is left, what a cut review left unread (`review-left.ts`), through the project's
 * review step's model and effort. Each finding is a notice offered to the page whose file it names,
 * once per page, else in the pass's header. The tip is recorded as read, and what was not read is
 * kept for the next review, the `review-cut` notice saying so until all of it is read. Answers what
 * it did; a failure to ask the model is thrown, and records nothing, so the next Open Pull Request
 * asks again.
 */
export async function reviewPassTip(
  deps: Pick<DeliveryContext, 'state' | 'git' | 'logger' | 'clock'> & PassReviewDeps,
  input: {
    readonly passId: PassId;
    readonly sha: string;
    /** The branch the pull request targets, as `origin` has it, for where the diff starts. */
    readonly baseRef: string | null;
    readonly signal: AbortSignal;
  },
): Promise<'reviewed' | 'unchanged' | 'none'> {
  const db = deps.state.db;
  const pass = getPass(db, input.passId);
  const project = getProject(db, pass.projectId);
  const repo = project.repoPath;
  const tasks = listPassTasks(db, input.passId);
  const [first] = tasks;
  const step = first === undefined ? undefined : reviewStep(db, first);
  if (step === undefined) return 'none';
  const last = getPassProgress(db, input.passId).reviewedSha;
  const left = reviewLeft(db, input.passId);
  const unread = left?.files ?? [];
  if (last === input.sha && unread.length === 0) return 'unchanged';
  const from =
    last ??
    (input.baseRef === null ? null : await deps.git.mergeBase(repo, input.baseRef, input.sha)) ??
    pass.startSha;
  // The new commits first, but for the files still unread, which the second part reads whole from
  // where they were left.
  const fresh =
    last === input.sha
      ? null
      : await deps.git.diffSince(repo, from, input.sha, PASS_REVIEW_DIFF_BYTES, { except: unread });
  const room = PASS_REVIEW_DIFF_BYTES - Buffer.byteLength(fresh?.diff ?? '');
  const rest =
    left === null || unread.length === 0 || room <= 0
      ? null
      : await deps.git.diffSince(repo, left.from, input.sha, room, { only: unread });
  const parts = [fresh, rest].filter((p): p is DiffSince => p !== null);
  const read = new Set(parts.flatMap(readWhole));
  const touched = [
    ...(fresh?.files.map((f) => f.path) ?? []),
    ...(rest === null ? unread : rest.files.map((f) => f.path)),
  ];
  const partial = new Set((left?.partial ?? []).filter((path) => !read.has(path)));
  // Nothing read whole (one file longer than the review reads): the file the cut fell in counts as
  // read as far as it went, so the next review moves on.
  const stuck = read.size === 0 ? parts.map(cutIn).find((p) => p !== null) : undefined;
  if (stuck !== undefined) partial.add(stuck);
  const files = [...new Set(touched)].filter((path) => !read.has(path) && path !== stuck).sort();
  const nextLeft: ReviewLeft | null =
    files.length === 0 && partial.size === 0
      ? null
      : { from: left?.from ?? from, files, partial: [...partial].sort() };
  const answer = await ask(deps, project, step, {
    prompt: passReviewPrompt({
      passName: pass.name,
      pages: tasks.map((t) => t.title),
      diff: parts
        .map((p) => p.diff)
        .filter((d) => d !== '')
        .join('\n'),
      truncated: parts.some((p) => p.truncated) || files.length > 0,
      sinceLastReview: last !== null,
    }),
    signal: input.signal,
  });
  const findings = /^\s*no findings\.?\s*$/i.test(answer) ? [] : parseFindings(answer);
  const pages = tasks.map((task) => ({
    taskId: task.id,
    areas: passHeldAreas(project.areas, task),
  }));
  const targets = findingTargets(findings, pages, project.areas);
  deps.state.write((w) => {
    const prefix = `${FINDING_NOTICE}${input.sha.slice(0, 12)}:`;
    // A review of a newer tip replaces the header's findings; one that reads on at the same tip
    // adds to them, each finding once, numbered past those it keeps.
    const header = getPassProgress(w.tx, input.passId).notices.filter((notice) =>
      notice.id.startsWith(FINDING_NOTICE),
    );
    if (last !== input.sha)
      for (const notice of header) clearPassNotice(w, input.passId, notice.id);
    const kept = last === input.sha ? header : [];
    const shown = new Set(kept.map((notice) => notice.text));
    let next = Math.max(0, ...kept.map((notice) => Number(notice.id.slice(prefix.length)) || 0));
    targets.forEach((target) => {
      const line = noticeLine(target.finding);
      if (target.taskId !== null) {
        // A finding the page's thread holds already, from a review that read the same lines, once.
        const said = listTaskThread(w.tx, target.taskId).some(
          (m) => m.author === TaskMessageAuthor.System && m.body === line,
        );
        if (said) return;
        const notice = insertSystemNotice(w, target.taskId, line);
        offerToAgent(w, notice.id, line);
        return;
      }
      if (shown.has(line)) return;
      shown.add(line);
      next += 1;
      setPassNotice(w, input.passId, {
        id: `${prefix}${String(next)}`,
        kind: PassNoticeKind.Finding,
        text: line,
        sendable: true,
        cardId: null,
        at: w.now,
      });
    });
    setReviewedSha(w, input.passId, input.sha);
    setReviewLeft(w, input.passId, nextLeft);
    if (nextLeft === null) clearPassNotice(w, input.passId, REVIEW_CUT_NOTICE);
    else
      setPassNotice(w, input.passId, {
        id: REVIEW_CUT_NOTICE,
        kind: PassNoticeKind.Finding,
        text: cutText(input.sha, nextLeft),
        sendable: false,
        cardId: null,
        at: w.now,
      });
  });
  deps.logger.info(
    {
      passId: input.passId,
      sha: input.sha,
      findings: targets.length,
      unread: nextLeft?.files.length ?? 0,
    },
    'pass pull request reviewed',
  );
  return 'reviewed';
}

async function ask(
  deps: Pick<DeliveryContext, 'state'> & PassReviewDeps,
  project: ProjectDto,
  step: WorkstreamStep,
  question: { readonly prompt: string; readonly signal: AbortSignal },
): Promise<string> {
  const launch = deps.launch(project.accountId, step.model);
  const cwd = await mkdtemp(join(deps.scratchRoot, 'pass-review-'));
  try {
    return await deps.adapter.complete({
      cwd,
      prompt: question.prompt,
      model: launch.model,
      env: launch.env,
      account: launch.expect,
      effort: step.effort,
      timeoutMs: PASS_REVIEW_TIMEOUT_MS,
      signal: question.signal,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
