import type { ChatDto } from '@10db/contracts';
import { Stack, Text, UnstyledButton } from '@mantine/core';
import { fromNow, useNow } from '../../shell/relative';

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
          <Text size="sm" lineClamp={1}>
            {chat.title}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {recentLine(chat, now)}
          </Text>
        </UnstyledButton>
      ))}
    </Stack>
  );
}
