import {
  AcceptanceVerdict,
  JudgeDecision,
  JudgeOutcome,
  type AcceptanceCriterionResult,
  type AcceptanceDetail,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import type { Git } from '../git';
import type { AssessReading, Judge, NoulQuestion } from '../judge';
import { readAcceptance, secondQuestions } from './read';

type DiffSince = Awaited<ReturnType<Git['diffSince']>>;

export const ACCEPTANCE_TIMEOUT_MS = 20_000;
export const ACCEPTANCE_SECOND_TIMEOUT_MS = 60_000;
/** The most characters of the change the judges read; past it they get the file list and each file's first hunks. */
export const ACCEPTANCE_DIFF_CAP = 60_000;

/** The least a file's first hunks get when the cap is shared among many files. */
const MIN_PER_FILE_CHARS = 400;

const UNASKED = 'unasked';
const UNASKED_QUESTION: NoulQuestion = {
  instructions:
    "Does the change do something the task didn't ask for? Compare the diff with the task and its criteria.",
  criteria: {
    true: "The change does something the task didn't ask for.",
    false: 'Everything the change does is something the task asked for.',
  },
};

export interface AcceptanceInput {
  readonly task: { readonly title: string; readonly why: string; readonly description: string };
  readonly criteria: readonly string[];
  readonly accepted: ReadonlySet<string>;
  readonly diff: DiffSince;
  readonly gate: { readonly command: string; readonly summary: string };
  /**
   * The build session's own report of this attempt: what it did, measured and skipped. It is the judged agent's
   * claim, so the questions weigh it only for criteria a diff can't show. Null when this attempt wrote none.
   */
  readonly report: string | null;
  readonly workstreamId: WorkstreamId;
  readonly taskId: TaskId;
}

const questionId = (index: number): string => `met_${String(index)}`;

function criterionQuestion(criterion: string): NoulQuestion {
  return {
    instructions: `Does the change meet this acceptance criterion: ${criterion}? Read the diff, the gate output and the build's report. A criterion about behavior is met only if the diff makes that behavior happen. A criterion about something outside the code, such as a measurement, an eval run, a number in the pull request or a recorded result, can be met only by the build's report, which is the build's own unverified claim: count it only when the report gives the specific result (the number, the command run, what it showed), never for a bare claim that it was done.`,
    criteria: {
      true: 'The change meets it.',
      false: 'The change does not meet it, or only partly.',
    },
  };
}

/** The diff as the judges read it: whole, or cut to each file's first hunks within the cap. */
function cappedDiff(diff: DiffSince): {
  readonly text: string;
  readonly truncated: boolean;
  readonly files: DiffSince['files'];
} {
  if (!diff.truncated && diff.diff.length <= ACCEPTANCE_DIFF_CAP)
    return { text: diff.diff, truncated: false, files: diff.files };
  const listLength = JSON.stringify(diff.files).length;
  const chunks = diff.diff.split(/^(?=diff --git )/m).filter((c) => c !== '');
  const each = Math.max(
    MIN_PER_FILE_CHARS,
    Math.floor((ACCEPTANCE_DIFF_CAP - listLength) / Math.max(1, chunks.length)),
  );
  const text = chunks
    .map((c) => (c.length > each ? c.slice(0, c.lastIndexOf('\n', each)) : c))
    .join('\n');
  return { text, truncated: true, files: diff.files };
}

/** The criteria text by question id, and the questions: one per criterion not accepted that `only` allows, plus `unasked`. */
function questionsFor(
  criteria: readonly string[],
  only: ReadonlySet<string>,
): { ids: Map<string, string>; questions: Record<string, NoulQuestion> } {
  const ids = new Map<string, string>();
  const questions: Record<string, NoulQuestion> = {};
  criteria.forEach((criterion, index) => {
    if (!only.has(criterion)) return;
    ids.set(questionId(index), criterion);
    questions[questionId(index)] = criterionQuestion(criterion);
  });
  questions[UNASKED] = UNASKED_QUESTION;
  return { ids, questions };
}

/** A call's probabilities keyed by criterion text instead of question id; the unasked answer set aside. */
function byCriterion(
  ids: ReadonlyMap<string, string>,
  probabilities: Readonly<Record<string, number>>,
): { byText: Record<string, number>; unasked: number | null } {
  const byText: Record<string, number> = {};
  for (const [id, criterion] of ids) {
    const p = probabilities[id];
    if (p !== undefined) byText[criterion] = p;
  }
  return { byText, unasked: probabilities[UNASKED] ?? null };
}

/** What the judge log records of a call: the worst verdict among the criteria it read. */
function logged(
  results: readonly AcceptanceCriterionResult[],
  p: readonly number[],
): AssessReading {
  const worst = [
    AcceptanceVerdict.NotMet,
    AcceptanceVerdict.Unclear,
    AcceptanceVerdict.Unread,
  ].find((v) => results.some((r) => r.verdict === v));
  const confidence = p.length === 0 ? 1 : Math.min(...p);
  return worst === undefined
    ? { answer: 'met', confidence, outcome: JudgeOutcome.Acted }
    : { answer: worst, confidence, outcome: JudgeOutcome.BelowFloor };
}

/**
 * Asks whether each acceptance criterion is met by the run's change: the cheap decision for every criterion the
 * builder hasn't accepted, then the stronger one for those it didn't read as met. Null when the first decision can't
 * be asked. A call that gives no answer leaves its criteria unread. Never throws.
 */
export async function checkAcceptance(
  deps: {
    readonly judge: Judge;
    readonly floors: { readonly first: number; readonly second: number };
  },
  input: AcceptanceInput,
  signal: AbortSignal,
): Promise<Omit<AcceptanceDetail, 'sentBack'> | null> {
  const { judge, floors } = deps;
  if (!(await judge.ready(JudgeDecision.Acceptance))) return null;
  const diff = cappedDiff(input.diff);
  const state = {
    task: input.task,
    criteria: input.criteria,
    diff: { text: diff.text, truncated: diff.truncated, changed_files: diff.files },
    gate: input.gate,
    build_report_unverified: input.report,
  };
  const ids = { workstreamId: input.workstreamId, taskId: input.taskId };
  const read = (
    only: ReadonlySet<string>,
    first: Readonly<Record<string, number>> | null,
  ): ((probabilities: Readonly<Record<string, number>>) => AssessReading) => {
    const { ids: map } = questionsFor(input.criteria, only);
    return (probabilities) => {
      const { byText } = byCriterion(map, probabilities);
      const results = readAcceptance({
        criteria: [...only],
        accepted: new Set(),
        first: first ?? byText,
        second: first === null ? null : byText,
        firstFloor: floors.first,
        secondFloor: floors.second,
      });
      return logged(results, Object.values(byText));
    };
  };

  const everything = new Set(input.criteria.filter((c) => !input.accepted.has(c)));
  const firstAsk = questionsFor(input.criteria, everything);
  const firstAnswer = await judge.assess({
    decision: JudgeDecision.Acceptance,
    state,
    questions: firstAsk.questions,
    read: read(everything, null),
    timeoutMs: ACCEPTANCE_TIMEOUT_MS,
    ...ids,
    signal,
  });
  const first =
    firstAnswer.kind === 'answered' ? byCriterion(firstAsk.ids, firstAnswer.probabilities) : null;

  const needSecond = secondQuestions(
    input.criteria,
    input.accepted,
    first?.byText ?? null,
    floors.first,
  );
  let second: ReturnType<typeof byCriterion> | null = null;
  if (needSecond.length > 0) {
    const only = new Set(needSecond);
    const secondAsk = questionsFor(input.criteria, only);
    const secondAnswer = await judge.assess({
      decision: JudgeDecision.AcceptanceSecond,
      state,
      questions: secondAsk.questions,
      read: read(only, first?.byText ?? {}),
      timeoutMs: ACCEPTANCE_SECOND_TIMEOUT_MS,
      secondary: true,
      ...ids,
      signal,
    });
    if (secondAnswer.kind === 'answered')
      second = byCriterion(secondAsk.ids, secondAnswer.probabilities);
  }

  const criteria = readAcceptance({
    criteria: input.criteria,
    accepted: input.accepted,
    first: first?.byText ?? null,
    second: second?.byText ?? null,
    firstFloor: floors.first,
    secondFloor: floors.second,
  });
  const unaskedP = Math.max(first?.unasked ?? 0, second?.unasked ?? 0);
  const unasked =
    unaskedP >= Math.max(floors.first, 0.5)
      ? `The change may do something the task didn't ask for (${unaskedP.toFixed(2)}).`
      : null;
  return { criteria, unasked };
}
