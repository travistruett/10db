import { ExternalLink } from '../board/pull-request-link';

/** AA's required credit, a phrase to end the dimmed line that sits above its scores. */
export function ArtificialAnalysisCredit() {
  return (
    <>
      Scores and speed:{' '}
      <ExternalLink
        size="xs"
        inText
        url="https://artificialanalysis.ai/"
        label="Artificial Analysis"
      />
    </>
  );
}
