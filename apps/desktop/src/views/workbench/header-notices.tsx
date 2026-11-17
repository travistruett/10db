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
import { withoutTerminalCodes } from '../../conversation';
import { useRestartPreview } from '../../daemon/preview-queries';
import { CodeSpans } from '../../shell/code-spans';

// Workbench spec §5.3, §5.5, §8.3, D19, D24: what the pass's header says about its pull request and
// checks. Nothing here reaches an agent by itself: Ask Agent to Fix sends a notice only to the page the
// builder picks, and Retarget answers its card only when clicked. One notice is one line; two or more
// fold into one line that names how many, so the header stays one glance tall until it is opened.

/** A failure is red; what only needs the builder's eye is yellow. */
const COLOR: Readonly<Record<PassNoticeKind, 'red' | 'yellow' | 'blue'>> = {
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
  [PassNoticeKind.Preview]: 'yellow',
  [PassNoticeKind.PreviewStarting]: 'blue',
  [PassNoticeKind.PreviewStopped]: 'red',
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
  /** A page takes a message only while the pass is open, so Ask Agent to Fix is offered only then. */
  readonly canSend: boolean;
  /** A Retarget card is answered while the pass is open or closed, never mid-close or mid-abandon. */
  readonly canRetarget: boolean;
  /** The pass is closing, so a close that stopped can go on from where it stopped. */
  readonly closing: boolean;
  readonly passId: PassViewDto['pass']['id'];
  readonly projectId: PassViewDto['pass']['projectId'];
}

/** A notice's first line, and the lines after it (a failed gate's log tail) or null for one line. */
/** A first line longer than this is clamped to one line, its whole text behind Show More. */
const LONG_LINE = 120;

function noticeLines(text: string): { readonly first: string; readonly rest: string | null } {
  const end = text.indexOf('\n');
  if (end === -1) return { first: text, rest: null };
  const rest = text.slice(end + 1);
  return { first: text.slice(0, end), rest: rest.trim() === '' ? null : rest };
}

function NoticeRow(props: NoticeRowProps) {
  const { notice, pages, inbox, canSend, canRetarget, closing, passId, projectId } = props;
  const send = useSendToAgent();
  const answer = useAnswerPassCard();
  const continuing = useContinueClose();
  const restarting = useRestartPreview();
  const card = retargetCard(notice, inbox);
  const color = COLOR[notice.kind];
  const Icon = color === 'red' ? IconAlertTriangle : IconInfoCircle;
  const sentTo = send.isSuccess
    ? pages.find((page) => page.taskId === send.variables.taskId)?.label
    : undefined;
  const failure =
    send.error?.message ??
    answer.error?.message ??
    continuing.error?.message ??
    restarting.error?.message ??
    null;
  const { first, rest } = noticeLines(notice.text);
  const [more, setMore] = useState(false);
  const expandable = rest !== null || first.length > LONG_LINE;
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
        <Text size="sm" {...(more ? {} : { lineClamp: 1 })} style={{ flex: 1, minWidth: 0 }}>
          <CodeSpans text={first} />
        </Text>
        {!expandable ? null : (
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
          // The close's notice says it stopped; Close Pass is not offered mid-close, so it goes on here.
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
        {notice.kind === PassNoticeKind.PreviewStopped ? (
          <Button
            variant="default"
            size="xs"
            loading={restarting.isPending}
            style={{ flex: 'none' }}
            onClick={() => {
              restarting.mutate(projectId);
            }}
          >
            Restart Preview
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
                Ask Agent to Fix
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Which page's agent?</Menu.Label>
              {pages.map((page) => (
                <Menu.Item
                  key={page.taskId}
                  onClick={() => {
                    send.mutate({ taskId: page.taskId, noticeId: notice.id });
                  }}
                >
                  {page.label}
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
          {withoutTerminalCodes(rest)}
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

/** The color of the worst notice: red before yellow before blue. */
function worstColor(notices: readonly PassNotice[]): 'red' | 'yellow' | 'blue' {
  const colors = notices.map((notice) => COLOR[notice.kind]);
  if (colors.includes('red')) return 'red';
  return colors.includes('yellow') ? 'yellow' : 'blue';
}

/** The pass's header notices, oldest first; nothing while it has none. */
export function HeaderNotices({ view, inbox }: HeaderNoticesProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const [head] = view.notices;
  if (head === undefined) return null;
  const state = view.pass.state;
  const list = (
    <Stack
      component="ul"
      id={listId}
      gap={4}
      m={0}
      p={0}
      aria-label="Notices"
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
          projectId={view.pass.projectId}
          canRetarget={state === PassState.Open || state === PassState.Closed}
        />
      ))}
    </Stack>
  );
  if (view.notices.length === 1) return list;
  const color = worstColor(view.notices);
  const Icon = color === 'red' ? IconAlertTriangle : IconInfoCircle;
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap" align="center">
        <Icon
          size={16}
          stroke={1.5}
          color={`var(--mantine-color-${color}-filled)`}
          style={{ flex: 'none' }}
          aria-hidden
        />
        <Text size="sm" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
          <Text span fw={600} inherit>
            {`${String(view.notices.length)} issues`}
          </Text>
          {open ? null : (
            <>
              {' · '}
              <CodeSpans text={noticeLines(head.text).first} />
            </>
          )}
        </Text>
        <Button
          variant="subtle"
          size="xs"
          style={{ flex: 'none' }}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => {
            setOpen((shown) => !shown);
          }}
        >
          {open ? 'Hide' : 'Show All'}
        </Button>
      </Group>
      {open ? list : null}
    </Stack>
  );
}
