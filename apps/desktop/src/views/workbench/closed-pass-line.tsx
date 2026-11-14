import {
  InboxState,
  PASS_MOVE_CHOICE,
  PassMoveDetail,
  PassMoveReason,
  PullRequestState,
  type InboxItemDto,
  type PassViewDto,
} from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { useAnswerPassCard } from '../../daemon/pass-close-queries';
import { CodeSpans } from '../../shell/code-spans';
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

/** What a closed pass waits for, in words true of its pull request and its Move card's reason. */
export function closedPassWords(view: PassViewDto, card: PassMoveDetail | null): string {
  const name = view.pass.name;
  switch (card?.reason) {
    case PassMoveReason.ClosedUnmerged:
      return `${name} finished; its pull request closed without merging.`;
    case PassMoveReason.Drift:
      return `${name} finished; its pull request merged, but other work reached ${card.base} first, so the folder waits to move.`;
    case PassMoveReason.CiFix:
      return `${name} finished; a fix was pushed to its pull request, so the folder waits to move.`;
    case PassMoveReason.Closed:
    case undefined:
      break;
  }
  const pr = view.pullRequest;
  if (pr === null) return `${name} finished with no pull request.`;
  switch (pr.state) {
    case PullRequestState.Closed:
      return `${name} finished; its pull request closed without merging.`;
    case PullRequestState.Merged:
      return `${name} finished; its pull request merged, and the folder moves to the base next.`;
    case PullRequestState.Open:
    case PullRequestState.Unknown:
    case null:
      return `${name} finished; it settles once its pull request merges.`;
  }
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
        <Text size="sm">
          <CodeSpans text={closedPassWords(view, card?.detail ?? null)} />
        </Text>
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
