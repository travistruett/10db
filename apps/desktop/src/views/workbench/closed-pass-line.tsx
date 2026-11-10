import {
  InboxState,
  PASS_MOVE_CHOICE,
  PassMoveDetail,
  type InboxItemDto,
  type PassViewDto,
} from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { useAnswerPassCard } from '../../daemon/pass-close-queries';
import { PullRequestLink } from '../board/pull-request-link';

/** The pass's open Move card (D22), with what it moves; null while none is open. */
function moveCard(
  view: PassViewDto,
  inbox: readonly InboxItemDto[],
): { readonly item: InboxItemDto; readonly detail: PassMoveDetail } | null {
  for (const item of inbox) {
    if (item.state !== InboxState.Open) continue;
    const detail = PassMoveDetail.safeParse(item.detail);
    if (detail.success && detail.data.passId === view.pass.id) return { item, detail: detail.data };
  }
  return null;
}

export interface ClosedPassLineProps {
  /** A pass that has closed and not settled. */
  readonly view: PassViewDto;
  /** The open Inbox items, which hold its Move card. */
  readonly inbox: readonly InboxItemDto[];
}

/**
 * A closed pass waiting to settle (Workbench spec §5.3, D22), in one line: its pull request, and,
 * while its Move card is open, Move `<branch>` to `origin/<base>`, which answers that card; a move
 * the daemon refuses says why.
 */
export function ClosedPassLine({ view, inbox }: ClosedPassLineProps) {
  const answer = useAnswerPassCard();
  const card = moveCard(view, inbox);
  const url = view.pullRequest?.url ?? card?.detail.prUrl ?? null;
  return (
    <Stack gap={4}>
      <Group gap="sm" wrap="wrap">
        <Text size="sm">{`${view.pass.name} closed; it settles once its pull request merges.`}</Text>
        {url === null ? null : <PullRequestLink url={url} />}
        {card === null ? null : (
          <Button
            variant="default"
            size="xs"
            loading={answer.isPending}
            onClick={() => {
              answer.mutate({ itemId: card.item.id, choice: PASS_MOVE_CHOICE });
            }}
          >
            {`Move ${card.detail.returnBranch} to origin/${card.detail.base}`}
          </Button>
        )}
      </Group>
      {answer.error ? (
        <Text size="sm" c="red">
          {answer.error.message}
        </Text>
      ) : null}
    </Stack>
  );
}
