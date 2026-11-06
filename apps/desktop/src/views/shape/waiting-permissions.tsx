import { InboxKind, type InboxAnswer, type InboxItemDto, type ShapeId } from '@10db/contracts';
import { Alert, Badge, Button, Group, Paper, Radio, Stack, Text, Textarea } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type KeyboardEvent } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import { queryKeys, useAnswerInbox, useInbox } from '../../daemon/queries';
import { CardBody } from '../inbox/inbox-card';
import { KIND_LABELS, optionLabel } from '../inbox/permission-labels';

/** The detail key the daemon writes on a card a conversation's session asked. */
const SHAPE_DETAIL_KEY = 'shapeId';

/** The open permission cards this conversation's session is waiting on. */
export function useWaitingPermissions(shapeId: ShapeId | null): InboxItemDto[] {
  const inbox = useInbox();
  if (shapeId === null) return [];
  return (inbox.data ?? []).filter(
    (item) => item.kind === InboxKind.Permission && item.detail?.[SHAPE_DETAIL_KEY] === shapeId,
  );
}

/**
 * The cards a Plan turn waits on, answered where the conversation shows them. The card is the
 * Inbox's own: the same answer endpoint, so the Inbox stops listing it and a card answered there
 * leaves here. It sits beside the transcript, not in its windowed list, so a scroll never
 * unmounts a choice or a note half made.
 */
export function WaitingPermissions({ shapeId }: { readonly shapeId: ShapeId | null }) {
  const cards = useWaitingPermissions(shapeId);
  if (cards.length === 0) return null;
  return (
    <Stack
      component="section"
      aria-label="Waiting for your answer"
      gap="xs"
      px="md"
      pb="xs"
      style={{ flex: 'none', maxHeight: '50%', overflowY: 'auto' }}
    >
      {cards.map((item) => (
        <WaitingPermission key={item.id} item={item} />
      ))}
    </Stack>
  );
}

function WaitingPermission({ item }: { readonly item: InboxItemDto }) {
  const answer = useAnswerInbox();
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const picked =
    choice ??
    (item.options.some((o) => o.label === item.recommendation) ? item.recommendation : null);

  const submit = (): void => {
    if (answer.isPending) return;
    if (picked === null || !item.options.some((o) => o.label === picked)) {
      setError('Choose an option first.');
      return;
    }
    const trimmed = note.trim();
    const body: InboxAnswer =
      trimmed === '' ? { choice: picked } : { choice: picked, note: trimmed };
    setError(null);
    answer.mutate(
      { id: item.id, answer: body },
      {
        onError: (failure) => {
          if (failure instanceof DaemonRequestError && failure.status === 409) {
            setError('This card was already answered.');
            void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
          } else {
            setError(failure.message);
          }
        },
      },
    );
  };
  const sendFromNote = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <Paper withBorder p="sm" role="group" aria-label={item.title}>
      <Stack gap="xs">
        <Group gap="sm" wrap="nowrap">
          <Badge size="sm" variant="light" color="yellow" style={{ flexShrink: 0 }}>
            {KIND_LABELS[item.kind]}
          </Badge>
          <Text fw={600} size="sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {item.title}
          </Text>
        </Group>
        <CardBody item={item} />
        <Radio.Group value={picked} onChange={setChoice} aria-label="Answer">
          <Stack gap={4}>
            {item.options.map((option) => (
              <Radio
                key={option.label}
                value={option.label}
                label={optionLabel(item, option)}
                description={option.description === '' ? undefined : option.description}
              />
            ))}
          </Stack>
        </Radio.Group>
        <Textarea
          label="Note for the agent (optional)"
          size="xs"
          autosize
          minRows={1}
          value={note}
          onChange={(e) => {
            setNote(e.currentTarget.value);
          }}
          onKeyDown={sendFromNote}
        />
        {error === null ? null : (
          <Alert color="red" variant="light" p="xs">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button size="xs" loading={answer.isPending} onClick={submit}>
            Send answer
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
