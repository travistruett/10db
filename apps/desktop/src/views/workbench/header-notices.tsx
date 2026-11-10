import {
  InboxState,
  PASS_RETARGET_CHOICE,
  PassNoticeKind,
  PassState,
  PassRetargetDetail,
  type InboxItemDto,
  type PassNotice,
  type PassViewDto,
} from '@10db/contracts';
import { Button, Group, Menu, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useId, useState } from 'react';
import {
  useAnswerPassCard,
  useContinueClose,
  useSendToAgent,
} from '../../daemon/pass-close-queries';

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
  [PassNoticeKind.TurnCheck]: 'red',
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
  /** A page takes a message only while the pass is open, so Send to Agent is offered only then. */
  readonly canSend: boolean;
  /** A Retarget card is answered while the pass is open or closed, never mid-close or mid-abandon. */
  readonly canRetarget: boolean;
  /** The pass is closing, so a close that stopped can go on from where it stopped. */
  readonly closing: boolean;
  readonly passId: PassViewDto['pass']['id'];
}

/** A notice's first line, and the lines after it (a failed gate's log tail) or null for one line. */
function noticeLines(text: string): { readonly first: string; readonly rest: string | null } {
  const end = text.indexOf('\n');
  if (end === -1) return { first: text, rest: null };
  const rest = text.slice(end + 1);
  return { first: text.slice(0, end), rest: rest.trim() === '' ? null : rest };
}

function NoticeRow(props: NoticeRowProps) {
  const { notice, pages, inbox, canSend, canRetarget, closing, passId } = props;
  const send = useSendToAgent();
  const answer = useAnswerPassCard();
  const continuing = useContinueClose();
  const card = retargetCard(notice, inbox);
  const color = COLOR[notice.kind];
  const Icon = color === 'red' ? IconAlertTriangle : IconInfoCircle;
  const sentTo = send.isSuccess
    ? pages.find((page) => page.taskId === send.variables.taskId)?.area
    : undefined;
  const failure = send.error?.message ?? answer.error?.message ?? continuing.error?.message ?? null;
  const { first, rest } = noticeLines(notice.text);
  const [more, setMore] = useState(false);
  const restId = useId();
  return (
    <Stack component="li" gap={4}>
      <Group gap="xs" wrap="nowrap" align="center">
        <Icon
          size={16}
          stroke={1.5}
          color={`var(--mantine-color-${color}-filled)`}
          style={{ flex: 'none' }}
          aria-hidden
        />
        <Text size="sm" style={{ flex: 1, minWidth: 0 }}>
          {first}
        </Text>
        {rest === null ? null : (
          <Button
            variant="subtle"
            size="xs"
            style={{ flex: 'none' }}
            aria-expanded={more}
            aria-controls={restId}
            onClick={() => {
              setMore((shown) => !shown);
            }}
          >
            {more ? 'Show Less' : 'Show More'}
          </Button>
        )}
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
        {closing && notice.kind === PassNoticeKind.Close ? (
          // The close's notice says it stopped; Close Pass… is not offered mid-close, so it goes on here.
          <Button
            variant="default"
            size="xs"
            loading={continuing.isPending}
            style={{ flex: 'none' }}
            onClick={() => {
              continuing.mutate(passId);
            }}
          >
            Continue Close
          </Button>
        ) : null}
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
        {notice.sendable && canSend && pages.length > 0 ? (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button
                variant="default"
                size="xs"
                loading={send.isPending}
                // Sent once is enough: that page's agent has it as the builder's message.
                disabled={send.isSuccess}
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
      {more && rest !== null ? (
        // A failed gate's log tail runs to a few kilobytes: its lines kept, scrolled within the header.
        <Text
          id={restId}
          size="xs"
          ff="monospace"
          pl={24}
          style={{
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {rest}
        </Text>
      ) : null}
    </Stack>
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
          canSend={state === PassState.Open}
          closing={state === PassState.Closing}
          passId={view.pass.id}
          canRetarget={state === PassState.Open || state === PassState.Closed}
        />
      ))}
    </Stack>
  );
}
