import {
  parseFindings,
  ROLE_LABEL,
  reviewRounds,
  Verdict,
  type WorkstreamStep,
} from '@10db/contracts';
import { Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { RelativeTime } from '../factory/relative-time';
import { FindingsList, FullReview } from './review-findings';

/** Every verdict the task's review steps gave, newest first, each with its findings. */
export function ReviewRoundsList({ steps }: { readonly steps: readonly WorkstreamStep[] }) {
  const rounds = reviewRounds(steps);
  if (rounds.length === 0) return null;
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        Reviews
      </Text>
      {rounds.map((round) => (
        <Paper
          key={`${String(round.stepIndex)}:${round.result.at}:${round.result.sessionId}`}
          withBorder
          p="sm"
          data-testid="review-round"
        >
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap">
                <Badge
                  size="sm"
                  variant="light"
                  color={round.result.verdict === Verdict.Reject ? 'red' : 'green'}
                >
                  {round.result.verdict === Verdict.Reject ? 'Sent back' : 'Approved'}
                </Badge>
                <Text size="sm">{round.personaName || ROLE_LABEL[round.role]}</Text>
              </Group>
              <RelativeTime at={round.result.at} />
            </Group>
            <FindingsList findings={parseFindings(round.result.summary)} />
            <FullReview summary={round.result.summary} />
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}
