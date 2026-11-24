import { InboxKind, isParkChoice, type InboxItemDto } from '@10db/contracts';
import { Alert, Button, Radio, Stack, Text, Textarea } from '@mantine/core';
import { IconHourglass } from '@tabler/icons-react';
import { useState } from 'react';
import { useAnswerInbox } from '../../daemon/queries';
import { useNow } from '../../shell/relative';
import { shortAgo } from '../factory/short-ago';
import { CardActions } from './card-actions';
import { cardAnswer } from './card-answer';
import { CardHeader } from './card-header';
import { defaultRecording } from './record-decision';
import { TakeBackModal } from './take-back-modal';
import { recipientsOf, WaitingDetail } from './waiting-row';
import { WaitingTaskLink } from './waiting-task-link';

/**
 * The content for a Waiting row, laid out as an Open question card is: the question and who it waits on,
 * the task it holds up, the message they got and the conversation since, then the builder's own answer as
 * the same choice cards, sent from the bar at the pane's foot beside Withdraw Question. There is no link to
 * the thread: it is @10db's direct message with them, which the builder can't open.
 */
export function WaitingContent({ item }: { readonly item: InboxItemDto }) {
  const now = useNow();
  const answer = useAnswerInbox();
  const [takingBack, setTakingBack] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const send = item.send;
  const who = recipientsOf(item);
  const others = (send?.people ?? []).filter((p) => !p.recipient).map((p) => p.name);
  // Parking the task is not an answer: Withdraw Question brings the card back to park it.
  const options = item.options.filter((option) => !isParkChoice(option.label));
  const sent = [
    send?.sentAt == null ? null : `asked ${shortAgo(send.sentAt, now)}`,
    send?.remindedAt == null ? null : `reminded ${shortAgo(send.remindedAt, now)}`,
    others.length === 0 ? null : `with ${others.join(', ')}`,
  ].filter((part) => part !== null);
  return (
    // It fills the pane, so the action bar sits at its foot however short the card is.
    <Stack gap="md" style={{ flex: 1 }}>
      <CardHeader
        item={item}
        icon={IconHourglass}
        kind={`Waiting on ${who}`}
        framed={false}
        extra={sent.length === 0 ? null : <span>{sent.join(' · ')}</span>}
      />
      <WaitingTaskLink item={item} />
      <WaitingDetail item={item} />
      {options.length === 0 ? null : (
        <Stack gap="xs">
          <Text size="sm" fw={600}>
            {`Or answer for ${who} yourself`}
          </Text>
          <Radio.Group value={choice} onChange={setChoice} aria-label="Your answer">
            <Stack gap="xs">
              {options.map((option) => (
                <Radio.Card key={option.label} value={option.label} p="sm">
                  <Stack gap={2}>
                    <Text size="sm" fw={500}>
                      {option.label}
                    </Text>
                    {option.description ? (
                      <Text size="xs" c="dimmed">
                        {option.description}
                      </Text>
                    ) : null}
                  </Stack>
                </Radio.Card>
              ))}
            </Stack>
          </Radio.Group>
        </Stack>
      )}
      {answer.isError ? (
        <Alert color="red" variant="light">
          {answer.error.message}
        </Alert>
      ) : null}
      <CardActions
        framed={false}
        note={
          options.length === 0 ? null : (
            <Textarea
              aria-label="Note"
              placeholder="Add a note (optional)"
              autosize
              minRows={1}
              maxRows={4}
              value={note}
              onChange={(e) => {
                setNote(e.currentTarget.value);
              }}
            />
          )
        }
      >
        <Button
          variant="default"
          onClick={() => {
            setTakingBack(true);
          }}
        >
          Withdraw Question
        </Button>
        {options.length === 0 ? null : (
          <Button
            disabled={choice === null}
            loading={answer.isPending}
            onClick={() => {
              if (choice === null) return;
              answer.mutate({
                id: item.id,
                answer: cardAnswer(
                  item,
                  choice,
                  note,
                  item.kind === InboxKind.Question ? defaultRecording(item) : null,
                ),
              });
            }}
          >
            {`Answer for ${who}`}
          </Button>
        )}
      </CardActions>
      <TakeBackModal
        item={item}
        opened={takingBack}
        onClose={() => {
          setTakingBack(false);
        }}
      />
    </Stack>
  );
}
