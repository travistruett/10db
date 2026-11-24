import { isParkChoice, type InboxItemDto } from '@10db/contracts';
import { Blockquote, Button, Group, Stack, Text } from '@mantine/core';
import { useAnswerInbox } from '../../daemon/queries';
import { cardAnswer } from './card-answer';
import { ConversationView } from './conversation-view';
import { defaultRecording } from './record-decision';
import { SlackText } from './slack-preview';

/** "Mark Ellis", "Mark Ellis + Ana Ortiz": who the question is out with. */
export function recipientsOf(item: InboxItemDto): string {
  return (item.send?.people ?? [])
    .filter((p) => p.recipient)
    .map((p) => p.name)
    .join(' + ');
}

/**
 * What a Waiting row shows: the message as sent, quoted so it reads as what they got rather than as 10db
 * talking to the builder, the conversation since, and the builder's own answers.
 */
export function WaitingDetail({ item }: { readonly item: InboxItemDto }) {
  const answer = useAnswerInbox();
  const send = item.send;
  if (send === null) return null;
  return (
    <Stack gap="sm">
      <Blockquote py="xs" px="md" cite={`What ${recipientsOf(item)} got in Slack`}>
        <Text size="sm" component="div">
          <SlackText text={send.text} />
        </Text>
      </Blockquote>
      <ConversationView send={send} />
      <Text size="sm" fw={600} mt="xs">
        Answer it yourself
      </Text>
      <Group gap="xs">
        {/* Parking the task is not an answer: Withdraw Question brings the card back to park it. */}
        {item.options
          .filter((option) => !isParkChoice(option.label))
          .map((option) => (
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
  );
}
