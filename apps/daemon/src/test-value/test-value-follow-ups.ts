import type { TaskId } from '@10db/contracts';
import {
  getTask,
  insertFollowUpTask,
  listTasks,
  type FollowUpFields,
  type WriteContext,
} from '@10db/db';
import { TestValueVerdict, type TestRef, type TestValueFlag } from './test-value-ask';

/** A task files at most this many from one judging, as a step files at most ten follow-ups. */
export const MAX_TEST_VALUE_FOLLOW_UPS = 10;

const TITLE_MAX = 200;
const NAME_MAX = 80;

const place = (ref: TestRef): string => `${ref.file}:${String(ref.line)}`;

/** A test name cut to fit a title, on one line. */
function shown(name: string): string {
  const oneLine = name.replace(/\s+/g, ' ');
  return oneLine.length > NAME_MAX ? `${oneLine.slice(0, NAME_MAX - 1)}…` : oneLine;
}

function titleOf(flag: TestValueFlag): string {
  const name = `"${shown(flag.test.name)}"`;
  const existing = flag.existing === null ? '' : `"${shown(flag.existing.name)}"`;
  const title = (() => {
    switch (flag.verdict) {
      case TestValueVerdict.FoldInto:
        return `Fold ${name} into ${existing}`;
      case TestValueVerdict.DuplicateOf:
        return `Remove ${name} as a duplicate of ${existing}`;
      case TestValueVerdict.MoveCheaper:
        return `Move ${name} to a cheaper level`;
    }
  })();
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

/** How a verdict reads in a sentence, with the test it names. */
function verdictText(flag: TestValueFlag): string {
  const where = flag.existing === null ? '' : `${place(flag.existing)} "${flag.existing.name}"`;
  switch (flag.verdict) {
    case TestValueVerdict.FoldInto:
      return `Fold into ${where}`;
    case TestValueVerdict.DuplicateOf:
      return `Duplicate of ${where}`;
    case TestValueVerdict.MoveCheaper:
      return 'Could be a test on a cheaper level';
  }
}

/** The follow-up task a flag makes: what to do with the test, and why a judge said so. */
export function testValueFollowUp(flag: TestValueFlag): FollowUpFields {
  const lines = [
    `The test-value judge flagged a test that commit ${flag.test.commit} added: ${verdictText(flag)} (confidence ${flag.confidence.toFixed(2)}).`,
    '',
    `New test: ${place(flag.test)} "${flag.test.name}"`,
    ...(flag.existing === null
      ? []
      : [`Existing test: ${place(flag.existing)} "${flag.existing.name}"`]),
    ...(flag.test.valueCard === null ? [] : ['', `Its value card: ${flag.test.valueCard}`]),
    '',
    'The judge reads names and bodies, not runs: check it before acting, and close this task if the test earns its place.',
  ];
  const done = (() => {
    switch (flag.verdict) {
      case TestValueVerdict.FoldInto:
        return `"${flag.test.name}" is a row or a case of "${flag.existing?.name ?? ''}", and the regression it names still fails a test`;
      case TestValueVerdict.DuplicateOf:
        return `"${flag.test.name}" is gone, or says in its card what it catches that "${flag.existing?.name ?? ''}" does not`;
      case TestValueVerdict.MoveCheaper:
        return `"${flag.test.name}" runs at the cheapest level that fails for its regression, or its card says why not`;
    }
  })();
  return { title: titleOf(flag), description: lines.join('\n'), acceptanceCriteria: [done] };
}

/** What the reviewer's brief says about the judge's answers other than keep; none when there are none. */
export function testValueBrief(flags: readonly TestValueFlag[]): string | null {
  if (flags.length === 0) return null;
  const rows = flags.map(
    (f) =>
      `- ${place(f.test)} "${f.test.name}": ${verdictText(f)} (confidence ${f.confidence.toFixed(2)})`,
  );
  return [
    'A judge read the tests this change added against the tests beside them and would not keep these. It is input, not a finding: check each against the change, and reject for one only when you would reject for it without the judge. A real problem that does not block goes in the followUps list.',
    ...rows,
  ].join('\n');
}

/**
 * Files one Icebox follow-up task for each flag, at most ten, naming the new test and the existing one. A
 * test whose follow-up already exists in the project is not filed again. Returns the titles filed.
 */
export function fileTestValueFollowUps(
  ctx: WriteContext,
  sourceId: TaskId,
  flags: readonly TestValueFlag[],
): string[] {
  if (flags.length === 0) return [];
  const source = getTask(ctx.tx, sourceId);
  const have = new Set(listTasks(ctx.tx, source.projectId).map((t) => t.title));
  const filed: string[] = [];
  for (const flag of flags) {
    if (filed.length >= MAX_TEST_VALUE_FOLLOW_UPS) break;
    const fields = testValueFollowUp(flag);
    if (have.has(fields.title)) continue;
    insertFollowUpTask(ctx, sourceId, fields);
    have.add(fields.title);
    filed.push(fields.title);
  }
  return filed;
}
