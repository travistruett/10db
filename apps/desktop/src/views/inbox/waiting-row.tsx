import type { InboxItemDto } from '@10db/contracts';
import { ActionIcon, Button, Group, Menu, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useState } from 'react';
import { useAnswerInbox } from '../../daemon/queries';
import { ProjectLabel } from '../../shell/project-label';
import { shortAgo } from '../factory/short-ago';
import { cardAnswer } from './card-answer';
import { ThreadLink } from './thread-link';
import { ConversationView } from './conversation-view';
import { defaultRecording } from './record-decision';
import { TakeBackModal } from './take-back-modal';
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

/**
 * One question out with someone: the question is the row's headline, and who has it and since when is
 * the line under it. Expanded, it shows the message and the conversation, with the builder's own answers.
 */
export function WaitingRow({ item, now }: { readonly item: InboxItemDto; readonly now: number }) {
  const [open, setOpen] = useState(false);
  const [takingBack, setTakingBack] = useState(false);
  const answer = useAnswerInbox();
  const send = item.send;
  if (send === null) return null;
  const { who, with: withWords } = whoWords(item);
  const permalink = send.permalink;
  const meta = [
    send.sentAt === null ? null : `sent ${shortAgo(send.sentAt, now)}`,
    send.remindedAt === null ? null : `reminded ${shortAgo(send.remindedAt, now)}`,
  ].filter((part) => part !== null);
  return (
    <Paper withBorder p="sm" {...{ [KEYS_IGNORE_ATTRIBUTE]: true }}>
      <Stack gap="xs">
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              marginTop: 7,
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
            <Text size="sm" fw={500} lineClamp={1}>
              {item.title}
            </Text>
            <Group gap={6} wrap="nowrap">
              <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                With
              </Text>
              <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap' }}>
                {who}
              </Text>
              {withWords === null ? null : (
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  {withWords}
                </Text>
              )}
              {meta.map((part) => (
                <Text key={part} size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  {`· ${part}`}
                </Text>
              ))}
            </Group>
          </UnstyledButton>
          <ProjectLabel projectId={item.projectId} />
          {permalink === null ? null : <ThreadLink permalink={permalink} />}
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
                  setTakingBack(true);
                }}
              >
                Take Back
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
        {open ? (
          <Stack gap="sm" pl={20}>
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
              {send.text}
            </Text>
            <ConversationView send={send} />
            <Text size="xs" c="dimmed">
              Answer it yourself:
            </Text>
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
            {answer.isError ? (
              <Text size="xs" c="red">
                {answer.error.message}
              </Text>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
      <TakeBackModal
        item={item}
        opened={takingBack}
        onClose={() => {
          setTakingBack(false);
        }}
      />
    </Paper>
  );
}
