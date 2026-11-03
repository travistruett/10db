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

/** How a review round came out, in the words and color the list and the drawer's latest-review line share. */
export function roundVerdict(
  steps: readonly WorkstreamStep[],
  round: ReviewRound,
): { readonly label: string; readonly color: 'green' | 'orange' | 'red' } {
  if (round.result.verdict !== Verdict.Reject) return { label: 'Approved', color: 'green' };
  // The step's latest result is the rejection that used up the limit; its work shipped with it open.
  const step = steps[round.stepIndex];
  const shippedAtLimit = step?.shippedAtLimit !== undefined && step.result === round.result;
  return shippedAtLimit
    ? { label: 'Open at the limit', color: 'orange' }
    : { label: 'Sent back', color: 'red' };
}

/** Who gave a round's verdict: the reviewer's name, else its role. */
export function roundReviewer(round: ReviewRound): string {
  return round.personaName || ROLE_LABEL[round.role];
}

/** Every verdict the task's review steps gave, newest first, each with its findings. */
export function ReviewRoundsList({ steps }: { readonly steps: readonly WorkstreamStep[] }) {
  const rounds = reviewRounds(steps);
  if (rounds.length === 0) return null;
  return (
    <Stack gap="xs">
      {rounds.map((round) => {
        const verdict = roundVerdict(steps, round);
        return (
          <Paper
            key={`${String(round.stepIndex)}:${round.result.at}:${round.result.sessionId}`}
            withBorder
            p="sm"
            data-testid="review-round"
          >
            <Stack gap="xs">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  <Badge size="sm" variant="light" color={verdict.color}>
                    {verdict.label}
                  </Badge>
                  <Text size="sm">{roundReviewer(round)}</Text>
                </Group>
                <RelativeTime at={round.result.at} />
              </Group>
              <FindingsList findings={parseFindings(round.result.summary)} />
              <FullReview summary={round.result.summary} />
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}
