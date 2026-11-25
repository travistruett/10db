import {
  InboxKind,
  type ConversationId,
  type DecisionRecording,
  type InboxItemDto,
} from '@10db/contracts';
import { Box, Button, Group, Stack } from '@mantine/core';
import { useRef, useState, type KeyboardEvent } from 'react';
import { DaemonRequestError } from '../daemon/client';
import { useAnswerInbox, useInbox } from '../daemon/queries';
import { cardAnswer, recommended } from '../views/inbox/card-answer';
import { InboxCard } from '../views/inbox/inbox-card';
import { AskCard } from './ask-card';
import { defaultRecording } from '../views/inbox/record-decision';
import { WAITING_CARD_ATTRIBUTE } from './escape';

// Sessions UI spec §7.7: the Inbox's own cards, answered where the conversation shows them. They sit
// pinned above the composer, outside the windowed list, so a scroll never unmounts a choice or a note
// half made.

/** The detail key the daemon writes on a card a conversation's session asked. */
const CONVERSATION_DETAIL_KEY = 'conversationId';

const CARD_KINDS: ReadonlySet<string> = new Set([InboxKind.Permission, InboxKind.Question]);

/** The open permission and question cards this conversation's session is waiting on. */
export function useConversationCards(conversationId: ConversationId | null): InboxItemDto[] {
  const inbox = useInbox();
  if (conversationId === null) return [];
  return (inbox.data ?? []).filter(
    (item) =>
      item.state === 'OPEN' &&
      CARD_KINDS.has(item.kind) &&
      item.detail?.[CONVERSATION_DETAIL_KEY] === conversationId,
  );
}

interface CardDraft {
  readonly choice: string | null;
  readonly note: string;
  /** Absent until the builder changes how a question is recorded. */
  readonly record?: DecisionRecording | null;
  readonly error: string | null;
}

const EMPTY: CardDraft = { choice: null, note: '', error: null };

const DIGIT = /^[1-5]$/;

const isField = (target: EventTarget): boolean =>
  target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');

function Request({
  item,
  onAnswered,
}: {
  readonly item: InboxItemDto;
  readonly onAnswered: (() => void) | undefined;
}) {
  const answer = useAnswerInbox();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<CardDraft>(EMPTY);
  const choice = draft.choice ?? recommended(item);
  const recording = draft.record !== undefined ? draft.record : defaultRecording(item);
  const patch = (change: Partial<CardDraft>): void => {
    setDraft((current) => ({ ...current, ...change }));
  };
  const submit = (): void => {
    if (answer.isPending) return;
    if (choice === null || !item.options.some((o) => o.label === choice)) {
      patch({ error: 'Choose an option first.' });
      return;
    }
    answer.mutate(
      { id: item.id, answer: cardAnswer(item, choice, draft.note, recording) },
      {
        ...(onAnswered === undefined ? {} : { onSuccess: onAnswered }),
        onError: (failure) => {
          patch({
            error:
              failure instanceof DaemonRequestError && failure.status === 409
                ? 'This card was already answered.'
                : failure.message,
          });
        },
      },
    );
  };
  // 1-5 pick an option and ⌘↩ sends, as in the Inbox; a key typed into the note is the note's.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
      return;
    }
    if (isField(event.target) || !DIGIT.test(event.key)) return;
    const option = item.options[Number(event.key) - 1];
    if (option === undefined) return;
    event.preventDefault();
    patch({ choice: option.label, error: null });
  };
  if (answer.isSuccess) return null;
  return (
    <Box {...{ [WAITING_CARD_ATTRIBUTE]: true }} onKeyDown={onKeyDown}>
      <InboxCard
        item={item}
        count={1}
        selected
        choice={choice}
        note={draft.note}
        recording={recording}
        error={draft.error}
        pending={answer.isPending}
        noteRef={noteRef}
        onChoose={(value) => {
          patch({ choice: value, error: null });
        }}
        onNote={(value) => {
          patch({ note: value });
        }}
        onRecord={(next) => {
          patch({ record: next });
        }}
        // A permission or question has no send-back note; only a check card does.
        sendBackNote=""
        onSendBackNote={() => undefined}
        onNoteFocus={() => undefined}
        onSubmit={submit}
        // A permission or question always has options, so it is never dismissed.
        onDismiss={() => undefined}
        shortcuts
      />
    </Box>
  );
}

const isAsk = (item: InboxItemDto): boolean => item.kind === InboxKind.Permission;

/** The permission cards, oldest first: the first docks, the others wait behind it. */
export function pendingAsks(items: readonly InboxItemDto[]): InboxItemDto[] {
  return items.filter(isAsk).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The question cards a conversation waits on, each keyed by its item so no draft passes to the next. */
export function PermissionRequest({
  items,
  onAnswered,
}: {
  readonly items: readonly InboxItemDto[];
  readonly onAnswered?: () => void;
}) {
  const questions = items.filter((item) => !isAsk(item));
  if (questions.length === 0) return null;
  return (
    <Stack
      component="section"
      aria-label="Waiting for your answer"
      gap="xs"
      px="md"
      pb="xs"
      style={{ flex: 'none', maxHeight: '50%', overflowY: 'auto' }}
    >
      {questions.map((item) => (
        <Request key={item.id} item={item} onAnswered={onAnswered} />
      ))}
    </Stack>
  );
}

/** The oldest permission card, docked in the composer's place; Stop stays on its row. */
export function DockedAsk({
  items,
  onStop,
  onAnswered,
}: {
  readonly items: readonly InboxItemDto[];
  readonly onStop: () => void;
  readonly onAnswered?: () => void;
}) {
  const asks = pendingAsks(items);
  const first = asks[0];
  if (first === undefined) return null;
  return (
    <Stack
      component="section"
      aria-label="Waiting for your answer"
      gap={4}
      px="md"
      pb="xs"
      style={{ flex: 'none' }}
    >
      <AskCard
        key={first.id}
        item={first}
        queued={asks.length - 1}
        {...(onAnswered === undefined ? {} : { onAnswered })}
      />
      <Group justify="flex-end">
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onStop}>
          Stop
        </Button>
      </Group>
    </Stack>
  );
}
