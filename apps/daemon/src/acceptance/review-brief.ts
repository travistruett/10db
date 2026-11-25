import { AcceptanceVerdict, type AcceptanceDetail } from '@10db/contracts';

/**
 * What a review's first round is told of the acceptance check: the criteria it could not settle and anything the
 * change does that the task didn't ask for. Input to the reviewer's own read, not a finding. Null when there is
 * nothing to say.
 */
export function acceptanceBrief(detail: AcceptanceDetail | null): string | null {
  if (detail === null) return null;
  const unclear = detail.criteria.filter((c) => c.verdict === AcceptanceVerdict.Unclear);
  if (unclear.length === 0 && detail.unasked === null) return null;
  return [
    'A check read each acceptance criterion against the change and could not settle these. It is input, not a finding: read each against the change yourself.',
    ...unclear.map((c) => `- ${c.criterion} (${c.note})`),
    ...(detail.unasked === null
      ? []
      : [`It may also do something the task did not ask for: ${detail.unasked}`]),
  ].join('\n');
}
