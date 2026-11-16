import {
  ScreenKind,
  type ConversationFileDto,
  type ConversationId,
  type NoticeOffer,
  type PassPageDto,
  type PassTurnWithFilesDto,
  type TaskId,
  type ToolCallView,
} from '@10db/contracts';
import { Button, Code, Group, Stack, Text } from '@mantine/core';
import { ConversationList } from '../../conversation';
import type { LiveItems } from '../../conversation/live-items';
import { useAllowed } from '../../conversation/row-state';
import {
  useConversationItemsState,
  useConversationPicture,
  useToolCallFull,
} from '../../daemon/conversation-queries';
import { useSendToAgent } from '../../daemon/pass-close-queries';
import { useTaskScreens } from '../../daemon/screen-queries';
import { CodeSpans } from '../../shell/code-spans';
import { pageEntries } from './page-entries';
import { TurnFiles } from './turn-files';
import { OpeningPictures, TurnPictures } from './turn-pictures';

export interface PageThreadProps {
  readonly page: PassPageDto;
  /** The page's turns, for the files each turn changed. */
  readonly turns: readonly PassTurnWithFilesDto[];
  /** What the page's conversation streams now. */
  readonly live: LiveItems;
  /** A reply is streaming: the list is busy. */
  readonly busy: boolean;
  /** The page takes a message: its pass is open, so a notice may be sent to its agent. */
  readonly canSend: boolean;
  /** Sends the builder's go-ahead for a call the judge held back softly, as their message. */
  readonly onAllow: (call: ToolCallView) => void;
}

/** A sent picture shows as a thumbnail in a row, not at the size it was taken. */
const THUMBNAIL_HEIGHT = 96;
const THUMBNAIL_MAX_WIDTH = 160;

/** A picture the builder sent, read with the UI token; its alt text is its file name. */
function MessagePicture({
  conversationId,
  file,
}: {
  readonly conversationId: ConversationId;
  readonly file: ConversationFileDto;
}) {
  const image = useConversationPicture(conversationId, file.id);
  if (image.isError)
    return (
      <Text size="xs" c="dimmed">
        {file.name} can no longer be shown.
      </Text>
    );
  if (image.data === undefined)
    return (
      <Text size="xs" c="dimmed">
        Loading {file.name}…
      </Text>
    );
  return (
    <img
      src={image.data}
      alt={file.name}
      height={THUMBNAIL_HEIGHT}
      style={{
        display: 'block',
        height: THUMBNAIL_HEIGHT,
        width: 'auto',
        maxWidth: THUMBNAIL_MAX_WIDTH,
        objectFit: 'cover',
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-sm)',
      }}
    />
  );
}

/**
 * A notice, dimmed. One the daemon offers with Ask Agent to Fix (D19: a review finding or a failed check)
 * has the button, which sends its text to this page as the builder's own message; nothing sends it by
 * itself. The button of a denied call reads Allow this: its text is the builder's go-ahead. That it was
 * sent is the list's row state, so a row drawn again never offers a second send.
 */
function PageNotice({
  id,
  taskId,
  text,
  offer,
  canSend,
}: {
  readonly id: string;
  readonly taskId: TaskId;
  readonly text: string;
  readonly offer: NoticeOffer | null;
  readonly canSend: boolean;
}) {
  const send = useSendToAgent();
  const [sent, markSent] = useAllowed(id);
  const words = (
    <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap', flex: 1, minWidth: 0 }}>
      <CodeSpans text={text} />
    </Text>
  );
  // A page takes a message only while its pass is open, so Ask Agent to Fix is offered only then.
  if (offer === null || !canSend) return <Group>{words}</Group>;
  return (
    <Group gap="xs" wrap="nowrap" align="center">
      {words}
      {send.error ? (
        <Text size="xs" c="red" role="alert">
          {send.error.message}
        </Text>
      ) : null}
      {sent ? (
        <Text size="xs" c="dimmed">
          Sent to the agent
        </Text>
      ) : null}
      <Button
        variant="default"
        size="xs"
        loading={send.isPending}
        // Sent once is enough: the agent has it as the builder's message.
        disabled={sent}
        style={{ flex: 'none' }}
        onClick={() => {
          send.mutate({ taskId, noticeId: id }, { onSuccess: markSent });
        }}
      >
        {offer === 'allow_this' ? 'Allow this' : 'Ask Agent to Fix'}
      </Button>
    </Group>
  );
}

/** Until the builder's first message the thread says where the page is; Open Page is the composer's. */
function WherePageIs({ page }: { readonly page: PassPageDto }) {
  if (page.route === null)
    return (
      <Text size="sm" c="dimmed">
        {page.label} names no route.
      </Text>
    );
  return (
    <Text size="sm" c="dimmed">
      <span>{page.label} is at</span> <Code>{page.route}</Code>
    </Text>
  );
}

/**
 * A page's thread on the kit's list: the builder's messages with their pictures, the agent's replies
 * as markdown, its thinking and tool rows, the notices, and each turn's files and pictures after its
 * reply. The goal's earlier pictures of the page and its before lead it.
 */
export function PageThread({ page, turns, live, busy, canSend, onAllow }: PageThreadProps) {
  const conversationId = page.conversationId;
  const { items, loading } = useConversationItemsState(conversationId);
  const loadFull = useToolCallFull(conversationId, items);
  const pictures = useTaskScreens(page.taskId).data;
  const screens = pictures?.screens ?? [];
  const fromGoal = pictures?.fromGoal ?? [];
  const name = page.label;
  const befores = screens.filter((s) => s.kind === ScreenKind.Before);
  if (loading)
    return (
      // It holds the list's place, so the composer is at the foot before the thread arrives.
      <Text size="sm" c="dimmed" px="md" style={{ flex: 1, minHeight: 0 }}>
        Loading the thread…
      </Text>
    );
  const spoken = items.some((item) => item.kind === 'message' && item.author === 'builder');
  const entries = pageEntries(items, live, turns, {
    opening: () => (
      <Stack gap="xs" pt="sm" align="flex-start">
        {spoken ? null : <WherePageIs page={page} />}
        <OpeningPictures fromGoal={fromGoal} befores={befores} name={name} />
      </Stack>
    ),
    pictures: (files) =>
      conversationId === null ? null : (
        <Group gap="xs" pt="xs" align="flex-start">
          {files.map((file) => (
            <MessagePicture key={file.id} conversationId={conversationId} file={file} />
          ))}
        </Group>
      ),
    notice: (id, text, offer) => (
      <PageNotice id={id} taskId={page.taskId} text={text} offer={offer} canSend={canSend} />
    ),
    turn: (turn) => (
      <Stack gap={4}>
        <TurnFiles files={turn.files} />
        <TurnPictures
          screens={screens.filter((s) => s.kind === ScreenKind.Turn && s.turnId === turn.id)}
          name={name}
        />
      </Stack>
    ),
  });
  return (
    <ConversationList
      entries={entries}
      highlight={null}
      loadFull={loadFull}
      {...(canSend ? { onAllow } : {})}
      agentLabel="Agent"
      busy={busy}
    />
  );
}
