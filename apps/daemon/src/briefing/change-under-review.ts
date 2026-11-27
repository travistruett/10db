/** A stretch of history made only of the run's commits: `base` is the commit before it. */
interface ReviewedRange {
  readonly base: string;
  readonly head: string;
}

/** The most commits the brief lists one by one; the ranges cover the rest. */
const LISTED_COMMITS = 40;
const SHORT_SHA = 12;

const LEAD =
  "This task runs in a copy whose branch other tasks also commit to. The change under review is only this task's own commits.";
const OUT_OF_SCOPE =
  "Changes on the branch from other tasks' commits, and from 10db's base merges, are out of scope: never reject the work or file a follow-up for them, and never ask for a ref that holds only this task's commits.";

/**
 * What a Review or QA step of a run in a shared copy is told the change is: the run's own commits, and
 * that the rest of the branch is not its to judge. `null` is a run whose commits git could not read.
 */
export function changeUnderReviewBrief(
  input: { readonly commits: readonly string[]; readonly ranges: readonly ReviewedRange[] } | null,
): string {
  if (input === null)
    return [
      LEAD,
      "The list of its commits could not be read: use `git log` and take the commits whose `10db-Op` trailers this run's commit calls wrote.",
      OUT_OF_SCOPE,
    ].join(' ');
  if (input.commits.length === 0)
    return [LEAD, 'This run committed nothing on the branch.', OUT_OF_SCOPE].join(' ');
  const listed = input.commits.slice(0, LISTED_COMMITS).map((sha) => sha.slice(0, SHORT_SHA));
  const more = input.commits.length - listed.length;
  return [
    `${LEAD} They are listed below, oldest first. Read each with \`git show <sha>\`, or each range with \`git diff <base> <head>\`.`,
    `Commits: ${listed.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}.`,
    `Ranges: ${input.ranges.map((r) => `${r.base} ${r.head}`).join('; ')}.`,
    OUT_OF_SCOPE,
  ].join('\n');
}
