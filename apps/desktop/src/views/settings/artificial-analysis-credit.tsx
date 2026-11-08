import { Text } from '@mantine/core';
import { ExternalLink } from '../board/pull-request-link';

/** AA's required credit: its name, linked, beside every view of its scores. */
export function ArtificialAnalysisCredit() {
  return (
    <Text size="xs" c="dimmed">
      Scores and speed:{' '}
      <ExternalLink url="https://artificialanalysis.ai/" label="Artificial Analysis" />{' '}
      (artificialanalysis.ai)
    </Text>
  );
}
