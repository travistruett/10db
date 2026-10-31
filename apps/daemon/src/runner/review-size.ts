import { RiskTag, type TaskDto, type WorkstreamStep } from '@10db/contracts';
import type { Git } from '../git';

type DiffSince = Awaited<ReturnType<Git['diffSince']>>;

/** Risks whose changes always get an independent review. */
const FORCING_RISKS: readonly RiskTag[] = [
  RiskTag.Security,
  RiskTag.Auth,
  RiskTag.Migration,
  RiskTag.Dependency,
];

/** A change over this many changed lines or files is reviewed without asking. */
const REVIEW_SIZE_MAX_LINES = 400;
const REVIEW_SIZE_MAX_FILES = 15;

/** The most diff text the model is shown. */
export const REVIEW_SIZE_DIFF_BYTES = 24 * 1024;

export const REVIEW_SIZE_QUESTION =
  'Does this change need an independent code review before it ships, or is it small, clear and covered by its tests?';

type TaskText = Pick<TaskDto, 'title' | 'description' | 'acceptanceCriteria' | 'riskTags'>;
type Changes = Pick<DiffSince, 'files'>;

/**
 * Whether the review step is asked about at all. A review the rules force runs with no call: a risk
 * tag that needs a second reader, a pinned step, a change too large to judge at a glance, and a review
 * that already ran and sent the work back, whose rework must be read again.
 */
export function reviewSizeRule(
  task: Pick<TaskText, 'riskTags'>,
  changes: Changes,
  step: Pick<WorkstreamStep, 'pinned' | 'result' | 'earlier'>,
): 'review' | 'ask' {
  if (task.riskTags.some((tag) => FORCING_RISKS.includes(tag))) return 'review';
  if (step.pinned) return 'review';
  if (step.result !== null || step.earlier.length > 0) return 'review';
  if (changes.files.length > REVIEW_SIZE_MAX_FILES) return 'review';
  const lines = changes.files.reduce((sum, f) => sum + (f.added ?? 0) + (f.removed ?? 0), 0);
  return lines > REVIEW_SIZE_MAX_LINES ? 'review' : 'ask';
}

function cappedDiff(diff: string): string {
  const bytes = Buffer.from(diff, 'utf8');
  if (bytes.length <= REVIEW_SIZE_DIFF_BYTES) return diff;
  // A cut inside a multi-byte character leaves a replacement character at the end.
  return `${bytes.subarray(0, REVIEW_SIZE_DIFF_BYTES).toString('utf8').replace(/�+$/, '')}\n[diff cut]`;
}

/** What the model reads: the task, the files and their counts, the diff cut at 24 KB, and the gate's result. */
export function reviewSizeState(
  task: TaskText,
  changes: Changes & Pick<DiffSince, 'diff'>,
  gate: string,
): string {
  const criteria = task.acceptanceCriteria.map((c, i) => `${String(i + 1)}. ${c}`).join('\n');
  const files = changes.files
    .map(
      (f) =>
        `${f.path} (+${f.added === null ? '?' : String(f.added)} -${f.removed === null ? '?' : String(f.removed)})`,
    )
    .join('\n');
  return [
    `Task: ${task.title}`,
    task.description,
    `Acceptance criteria:\n${criteria}`,
    `Files changed:\n${files}`,
    `Diff:\n${cappedDiff(changes.diff)}`,
    `Gate result: ${gate}`,
  ].join('\n\n');
}
