import type { ChatDto } from '@10db/contracts';
import { Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { useInbox } from '../../daemon/queries';
import { fromNow, useNow } from '../../shell/relative';
import { openCardsByConversation } from './needs-you';
import { readSeen } from './seen';
import { Mark } from './tab-mark';
import { chatInfo } from './tab-info';

// Sessions UI spec §6.2: the project's last sessions. One click opens one in this tab.

const filed = (n: number): string => `${String(n)} ${n === 1 ? 'task' : 'tasks'} filed`;

/** "Chat · 2 hours ago", with what the chat produced. */
export function recentLine(chat: ChatDto, now: number): string {
  const parts = ['Chat'];
  if (chat.lastActivityAt !== null) parts.push(fromNow(chat.lastActivityAt, now));
  if (chat.tasksFiled > 0) parts.push(filed(chat.tasksFiled));
  return parts.join(' · ');
}

export function RecentSessions({
  chats,
  onOpen,
}: {
  readonly chats: readonly ChatDto[];
  readonly onOpen: (chat: ChatDto) => void;
}) {
  const now = useNow();
  const cards = openCardsByConversation(useInbox().data ?? []);
  const seen = readSeen();
  const marks = new Map(chats.map((chat) => [chat.id, chatInfo(chat, cards, seen)]));
  if (chats.length === 0) return null;
  return (
    <Stack gap={2} component="section" aria-label="Recent">
      <Text size="xs" fw={600} c="dimmed">
        Recent
      </Text>
      {chats.map((chat) => (
        <UnstyledButton
          key={chat.id}
          onClick={() => {
            onOpen(chat);
          }}
          py={4}
          px="xs"
          style={{ borderRadius: 'var(--mantine-radius-sm)' }}
        >
          <Group gap={6} wrap="nowrap">
            <Text size="sm" lineClamp={1}>
              {chat.title}
            </Text>
            <Mark mark={marks.get(chat.id)?.words.mark ?? null} />
          </Group>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {[recentLine(chat, now), marks.get(chat.id)?.words.spoken ?? '']
              .filter((p) => p !== '')
              .join(' · ')}
          </Text>
        </UnstyledButton>
      ))}
    </Stack>
  );
}
