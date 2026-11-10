import {
  TaskMessageKind,
  type PassTurnWithFilesDto,
  type TaskFileDto,
  type TaskMessageDto,
} from '@10db/contracts';
import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import { useSendToAgent } from '../../daemon/pass-close-queries';
import { useTaskPicture } from '../../daemon/thread-queries';
import { TurnFiles } from './turn-files';

/** A pasted picture, read with the UI token; its alt text is its file name. */
function ThreadPicture({ file }: { readonly file: TaskFileDto }) {
  const image = useTaskPicture(file.taskId, file.id);
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
      style={{
        display: 'block',
        maxWidth: '100%',
        height: 'auto',
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-sm)',
      }}
    />
  );
}

/** Message text is the builder's or an agent's: it is only ever rendered as text. */
function Body({ text }: { readonly text: string }) {
  if (text === '') return null;
  return (
    <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {text}
    </Text>
  );
}

/**
 * A notice, dimmed. One the daemon offers with Send to Agent (D19: a review finding or a failed
 * check) has the button, which sends its text to this page as the builder's own message; nothing
 * sends it by itself.
 */
function Notice({
  message,
  canSend,
}: {
  readonly message: TaskMessageDto;
  readonly canSend: boolean;
}) {
  const send = useSendToAgent();
  const text = (
    <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap', flex: 1, minWidth: 0 }}>
      {message.body}
    </Text>
  );
  // A page takes a message only while its pass is open, so Send to Agent is offered only then.
  if (!message.sendable || !canSend) return <Group px="sm">{text}</Group>;
  return (
    <Group px="sm" gap="xs" wrap="nowrap" align="center">
      {text}
      {send.error ? (
        <Text size="xs" c="red" role="alert">
          {send.error.message}
        </Text>
      ) : null}
      {send.isSuccess ? (
        <Text size="xs" c="dimmed">
          Sent to the agent
        </Text>
      ) : null}
      <Button
        variant="default"
        size="xs"
        loading={send.isPending}
        style={{ flex: 'none' }}
        onClick={() => {
          send.mutate({ taskId: message.taskId, noticeId: message.id });
        }}
      >
        Send to Agent
      </Button>
    </Group>
  );
}

export interface ThreadMessageProps {
  readonly message: TaskMessageDto;
  /** For a reply, the turn it ends, whose changed files it shows. */
  readonly turn: PassTurnWithFilesDto | null;
  /** The page takes a message: its pass is open. */
  readonly canSend: boolean;
}

/** One entry of a page's thread: the builder's message with its pictures, a reply, or a notice. */
export function ThreadMessage({ message, turn, canSend }: ThreadMessageProps) {
  switch (message.kind) {
    case TaskMessageKind.Message:
      return (
        <Paper bg="var(--mantine-color-default)" p="sm" radius="md">
          <Stack gap="xs">
            <Body text={message.body} />
            {message.files.map((file) => (
              <ThreadPicture key={file.id} file={file} />
            ))}
          </Stack>
        </Paper>
      );
    case TaskMessageKind.Reply:
      return (
        <Stack gap="xs" px="sm">
          <Body text={message.body} />
          <TurnFiles files={turn?.files ?? []} />
        </Stack>
      );
    case TaskMessageKind.Notice:
      return <Notice message={message} canSend={canSend} />;
  }
}
