import {
  InboxState,
  PASS_RETARGET_CHOICE,
  PassNoticeKind,
  PassState,
  PassRetargetDetail,
  passHoldsTasks,
  type InboxItemDto,
  type PassNotice,
  type PassViewDto,
} from '@10db/contracts';
import { Button, Group, Menu, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useAnswerPassCard, useSendToAgent } from '../../daemon/pass-close-queries';

// Workbench spec §5.3, §5.5, §8.3, D19, D24: what the pass's header says about its pull request and
// checks. Nothing here reaches an agent by itself: Send to Agent sends a notice only to the page the
// builder picks, and Retarget answers its card only when clicked.

/** A failure is red; what only needs the builder's eye is yellow. */
const COLOR: Readonly<Record<PassNoticeKind, 'red' | 'yellow'>> = {
  [PassNoticeKind.Checks]: 'red',
  [PassNoticeKind.GateFailed]: 'red',
  [PassNoticeKind.PrNotOpened]: 'red',
  [PassNoticeKind.ReviewFailed]: 'red',
  [PassNoticeKind.Close]: 'red',
  [PassNoticeKind.PrClosed]: 'yellow',
  [PassNoticeKind.Finding]: 'yellow',
  [PassNoticeKind.StackUnmerged]: 'yellow',
  [PassNoticeKind.StackMerged]: 'yellow',
};

/** The open Retarget card a notice names, with the base it retargets to; null without one. */
function retargetCard(
  notice: PassNotice,
  inbox: readonly InboxItemDto[],
): { readonly item: InboxItemDto; readonly base: string } | null {
  const item = inbox.find((candidate) => candidate.id === notice.cardId);
  if (item?.state !== InboxState.Open) return null;
  const detail = PassRetargetDetail.safeParse(item.detail);
  return detail.success ? { item, base: detail.data.base } : null;
}

interface NoticeRowProps {
  readonly notice: PassNotice;
  readonly pages: PassViewDto['pages'];
  readonly inbox: readonly InboxItemDto[];
  /** Send to Agent is offered while the pass holds pages, and a page takes a message only while it is open. */
  readonly sendTo: 'offered' | 'waiting' | 'none';
  /** A Retarget card is answered while the pass is open or closed, never mid-close or mid-abandon. */
  readonly canRetarget: boolean;
}

function NoticeRow({ notice, pages, inbox, sendTo, canRetarget }: NoticeRowProps) {
  const send = useSendToAgent();
  const answer = useAnswerPassCard();
  const card = retargetCard(notice, inbox);
  const color = COLOR[notice.kind];
  const Icon = color === 'red' ? IconAlertTriangle : IconInfoCircle;
  const sentTo = send.isSuccess
    ? pages.find((page) => page.taskId === send.variables.taskId)?.area
    : undefined;
  const failure = send.error?.message ?? answer.error?.message ?? null;
  return (
    <Group component="li" gap="xs" wrap="nowrap" align="center">
      <Icon
        size={16}
        stroke={1.5}
        color={`var(--mantine-color-${color}-filled)`}
        style={{ flex: 'none' }}
        aria-hidden
      />
      <Text size="sm" style={{ flex: 1, minWidth: 0 }}>
        {notice.text}
      </Text>
      {failure === null ? null : (
        <Text size="xs" c="red" role="alert">
          {failure}
        </Text>
      )}
      {sentTo === undefined ? null : (
        <Text size="xs" c="dimmed">
          {`Sent to ${sentTo}`}
        </Text>
      )}
      {card === null ? null : (
        <Button
          variant="default"
          size="xs"
          loading={answer.isPending}
          disabled={!canRetarget}
          onClick={() => {
            answer.mutate({ itemId: card.item.id, choice: PASS_RETARGET_CHOICE });
          }}
        >
          {`Retarget to ${card.base}`}
        </Button>
      )}
      {notice.sendable && sendTo !== 'none' && pages.length > 0 ? (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Button
              variant="default"
              size="xs"
              loading={send.isPending}
              disabled={sendTo !== 'offered'}
              style={{ flex: 'none' }}
            >
              Send to Agent
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Send to which page?</Menu.Label>
            {pages.map((page) => (
              <Menu.Item
                key={page.taskId}
                onClick={() => {
                  send.mutate({ taskId: page.taskId, noticeId: notice.id });
                }}
              >
                {page.area}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      ) : null}
    </Group>
  );
}

export interface HeaderNoticesProps {
  readonly view: PassViewDto;
  /** The open Inbox items, which hold the cards a notice acts through. */
  readonly inbox: readonly InboxItemDto[];
}

/** The pass's header notices, oldest first; nothing while it has none. */
export function HeaderNotices({ view, inbox }: HeaderNoticesProps) {
  if (view.notices.length === 0) return null;
  const state = view.pass.state;
  return (
    <Stack
      component="ul"
      gap={4}
      m={0}
      p={0}
      aria-label="Pass notices"
      style={{ listStyle: 'none' }}
    >
      {view.notices.map((notice) => (
        <NoticeRow
          key={notice.id}
          notice={notice}
          pages={view.pages}
          inbox={inbox}
          sendTo={state === PassState.Open ? 'offered' : passHoldsTasks(state) ? 'waiting' : 'none'}
          canRetarget={state === PassState.Open || state === PassState.Closed}
        />
      ))}
    </Stack>
  );
}
