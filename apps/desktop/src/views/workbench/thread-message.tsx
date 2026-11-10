import {
  TaskMessageKind,
  type PassTurnWithFilesDto,
  type TaskFileDto,
  type TaskMessageDto,
} from '@10db/contracts';
import { Paper, Stack, Text } from '@mantine/core';
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

export interface ThreadMessageProps {
  readonly message: TaskMessageDto;
  /** For a reply, the turn it ends, whose changed files it shows. */
  readonly turn: PassTurnWithFilesDto | null;
}

/** One entry of a page's thread: the builder's message with its pictures, a reply, or a notice. */
export function ThreadMessage({ message, turn }: ThreadMessageProps) {
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
      return (
        <Text size="xs" c="dimmed" px="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {message.body}
        </Text>
      );
  }
}
