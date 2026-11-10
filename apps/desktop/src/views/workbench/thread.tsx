import {
  ScreenKind,
  TaskMessageKind,
  type PassPageDto,
  type PassTurnWithFilesDto,
} from '@10db/contracts';
import { Code, Stack, Text } from '@mantine/core';
import { useTaskScreens } from '../../daemon/screen-queries';
import { useTaskThread } from '../../daemon/thread-queries';
import { turnOfReply } from './reply-turns';
import { ThreadMessage } from './thread-message';
import { TurnPictures } from './turn-pictures';

export interface ThreadProps {
  readonly page: PassPageDto;
  /** The page's turns, for the files each reply's turn changed. */
  readonly turns: readonly PassTurnWithFilesDto[];
  /** The page takes a message: its pass is open, so a notice may be sent to its agent. */
  readonly canSend: boolean;
}

/**
 * Until the builder's first message the thread is not blank: it says where the page is, above any
 * notice that lands first. Open Page is the composer's, so it is not repeated here.
 */
function BeforeFirstMessage({ page }: { readonly page: PassPageDto }) {
  if (page.route === null)
    return (
      <Text size="sm" c="dimmed">
        {page.area} names no route.
      </Text>
    );
  return (
    <Text size="sm" c="dimmed">
      <span>{page.area} is at</span> <Code>{page.route}</Code>
    </Text>
  );
}

/** A page area's name as a picture names it: "settings" reads "Settings". */
const pageName = (area: string): string => area.charAt(0).toUpperCase() + area.slice(1);

/**
 * A page's thread, oldest first: the builder's messages, the agent's replies and the notices. The
 * page's before picture leads it, and each turn's pictures follow its reply.
 */
export function Thread({ page, turns, canSend }: ThreadProps) {
  const thread = useTaskThread(page.taskId);
  const screens = useTaskScreens(page.taskId).data?.screens ?? [];
  const name = pageName(page.area);
  const befores = screens.filter((s) => s.kind === ScreenKind.Before);
  if (thread.isError)
    return (
      <Text size="sm" c="red" px="md">
        The thread could not be read: {thread.error.message}
      </Text>
    );
  const messages = thread.data?.messages;
  if (messages === undefined)
    return (
      <Text size="sm" c="dimmed" px="md">
        Loading the thread…
      </Text>
    );
  const intro = messages.some((message) => message.kind === TaskMessageKind.Message) ? null : (
    <Stack gap="xs" px="md" pt="sm" align="flex-start">
      <BeforeFirstMessage page={page} />
      <TurnPictures screens={befores} name={name} />
    </Stack>
  );
  if (messages.length === 0) return intro;
  return (
    <>
      {intro}
      <Stack
        component="ol"
        aria-label="Thread"
        gap="md"
        m={0}
        px="md"
        py="sm"
        style={{ listStyle: 'none' }}
      >
        {intro === null && befores.length > 0 && (
          <li>
            <TurnPictures screens={befores} name={name} />
          </li>
        )}
        {messages.map((message) => {
          const turn = message.kind === TaskMessageKind.Reply ? turnOfReply(message, turns) : null;
          return (
            <li key={message.id}>
              <ThreadMessage message={message} turn={turn} canSend={canSend} />
              {turn !== null && (
                <TurnPictures
                  screens={screens.filter(
                    (s) => s.kind === ScreenKind.Turn && s.turnId === turn.id,
                  )}
                  name={name}
                />
              )}
            </li>
          );
        })}
      </Stack>
    </>
  );
}
