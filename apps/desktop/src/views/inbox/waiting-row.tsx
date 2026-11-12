import type { InboxItemDto } from '@10db/contracts';
import {
  ActionIcon,
  Anchor,
  Button,
  Group,
  Menu,
  Paper,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useState } from 'react';
import { useTakeBack } from '../../daemon/people';
import { useAnswerInbox } from '../../daemon/queries';
import { isTauri, openInBrowser } from '../../desktop/tauri';
import { ProjectLabel } from '../../shell/project-label';
import { shortAgo } from '../factory/short-ago';
import { cardAnswer } from './card-answer';
import { ConversationView } from './conversation-view';
import { defaultRecording } from './record-decision';
import { KEYS_IGNORE_ATTRIBUTE } from './use-inbox-keys';

/** "Mark Ellis", "Mark Ellis + Ana Ortiz": who the question is out with. */
function whoWords(item: InboxItemDto): { readonly who: string; readonly with: string | null } {
  const people = item.send?.people ?? [];
  const recipients = people.filter((p) => p.recipient).map((p) => p.name);
  const others = people.filter((p) => !p.recipient).map((p) => p.name);
  return {
    who: recipients.join(' + '),
    with: others.length > 0 ? `with ${others.join(', ')}` : null,
  };
}

/** One question out with someone: a dense row, expanded to the conversation. */
export function WaitingRow({ item, now }: { readonly item: InboxItemDto; readonly now: number }) {
  const [open, setOpen] = useState(false);
  const takeBack = useTakeBack();
  const answer = useAnswerInbox();
  const send = item.send;
  if (send === null) return null;
  const { who, with: withWords } = whoWords(item);
  const permalink = send.permalink;
  return (
    <Paper withBorder p="sm" {...{ [KEYS_IGNORE_ATTRIBUTE]: true }}>
      <Stack gap="xs">
        <Group gap="sm" wrap="nowrap">
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              flexShrink: 0,
              background: 'var(--mantine-color-yellow-6)',
            }}
          />
          <UnstyledButton
            onClick={() => {
              setOpen((o) => !o);
            }}
            style={{ flex: 1, minWidth: 0 }}
            aria-expanded={open}
          >
            <Group gap="sm" wrap="nowrap">
              <Text size="sm" fw={600} style={{ whiteSpace: 'nowrap' }}>
                {who}
              </Text>
              {withWords === null ? null : (
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  {withWords}
                </Text>
              )}
              <Text size="sm" lineClamp={1} style={{ minWidth: 0 }}>
                {item.title}
              </Text>
            </Group>
          </UnstyledButton>
          <ProjectLabel projectId={item.projectId} />
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {send.sentAt === null ? '' : `sent ${shortAgo(send.sentAt, now)}`}
          </Text>
          {send.remindedAt === null ? null : (
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {`reminded ${shortAgo(send.remindedAt, now)}`}
            </Text>
          )}
          {permalink === null ? null : (
            <Anchor
              href={permalink}
              target="_blank"
              rel="noreferrer"
              size="sm"
              aria-label="Open in Slack"
              onClick={(event) => {
                if (!isTauri()) return;
                event.preventDefault();
                openInBrowser(permalink).catch(() => undefined);
              }}
            >
              ↗
            </Anchor>
          )}
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" aria-label="More for this question">
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                onClick={() => {
                  setOpen(true);
                }}
              >
                Answer Myself
              </Menu.Item>
              <Menu.Item
                onClick={() => {
                  takeBack.mutate(item.id);
                }}
              >
                Take Back
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
        {open ? (
          <Stack gap="sm">
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
              {send.text}
            </Text>
            <ConversationView send={send} />
            <Group gap="xs">
              {item.options.map((option) => (
                <Button
                  key={option.label}
                  size="xs"
                  variant="default"
                  aria-label={`Answer Myself: ${option.label}`}
                  loading={answer.isPending}
                  onClick={() => {
                    answer.mutate({
                      id: item.id,
                      answer: cardAnswer(item, option.label, '', defaultRecording(item)),
                    });
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </Group>
            {answer.isError || takeBack.isError ? (
              <Text size="xs" c="red">
                {answer.error?.message ?? takeBack.error?.message}
              </Text>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
}
