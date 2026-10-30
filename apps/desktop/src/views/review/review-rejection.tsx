import {
  ROLE_LABEL,
  REVIEW_CARD_DETAIL,
  ReviewCardDetail,
  type InboxItemDto,
} from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import { FindingsList, FullReview } from './review-findings';

/** The review that failed a workstream, read from its card; null for any other card. */
export function reviewRejection(item: InboxItemDto): ReviewCardDetail | null {
  // The detail is JSON read back from the database: a boundary, so parse it.
  const parsed = ReviewCardDetail.safeParse(item.detail?.[REVIEW_CARD_DETAIL]);
  return parsed.success ? parsed.data : null;
}

/** What the last review found, on the card of the workstream it failed. */
export function ReviewRejection({ review }: { readonly review: ReviewCardDetail }) {
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>{`${review.personaName || ROLE_LABEL[review.role]} found`}</Text>
      <FindingsList findings={review.findings} />
      <FullReview summary={review.summary} />
    </Stack>
  );
}
