import {
  parseFindings,
  ROLE_LABEL,
  reviewRounds,
  Verdict,
  type ReviewRound,
  type WorkstreamStep,
} from '@10db/contracts';
import { Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { RelativeTime } from '../factory/relative-time';
import { FindingsList, FullReview } from './review-findings';

/** Every verdict the task's review steps gave, newest first, each with its findings. */
export function ReviewRoundsList({ steps }: { readonly steps: readonly WorkstreamStep[] }) {
  const rounds = reviewRounds(steps);
  if (rounds.length === 0) return null;
  // The step's latest result is the rejection that used up the limit; its work shipped with it open.
  const shippedAt = (round: ReviewRound) => {
    const step = steps[round.stepIndex];
    return step?.shippedAtLimit !== undefined && step.result === round.result;
  };
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
                  color={
                    round.result.verdict !== Verdict.Reject
                      ? 'green'
                      : shippedAt(round)
                        ? 'orange'
                        : 'red'
                  }
                >
                  {round.result.verdict !== Verdict.Reject
                    ? 'Approved'
                    : shippedAt(round)
                      ? 'Open at the limit'
                      : 'Sent back'}
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
