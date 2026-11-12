import type { DecisionRecording, InboxItemDto } from '@10db/contracts';
import { Box } from '@mantine/core';
import { useRef, useState } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import { useAnswerInbox } from '../../daemon/queries';
import { cardAnswer, recommended } from '../inbox/card-answer';
import { InboxCard } from '../inbox/inbox-card';
import { defaultRecording } from '../inbox/record-decision';

/** What the builder has picked and typed on the card. */
interface Draft {
  readonly choice: string | null;
  readonly note: string;
  /** Absent until the builder changes how a question is recorded. */
  readonly record?: DecisionRecording | null;
  readonly error: string | null;
}

const EMPTY: Draft = { choice: null, note: '', error: null };

/**
 * The page's open question or permission, answered on the page as the Inbox answers it (Workbench
 * spec §4.3, W5): the Inbox's own card, its options, note and recording, through
 * `POST /inbox/:id/answer`. Answered here, it goes at once; answered in the Inbox, once the Inbox is
 * read again. Drawn keyed by the item's id, so a draft or a pending answer never passes to another card.
 */
export function PageAsk({ item }: { readonly item: InboxItemDto }) {
  const answer = useAnswerInbox();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const choice = draft.choice ?? recommended(item);
  const recording = draft.record !== undefined ? draft.record : defaultRecording(item);
  const patch = (change: Partial<Draft>): void => {
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
  if (answer.isSuccess) return null;
  return (
    <Box px="md" py="xs">
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
        onSelect={() => undefined}
        onChoose={(value) => {
          patch({ choice: value, error: null });
        }}
        onNote={(value) => {
          patch({ note: value });
        }}
        onRecord={(next) => {
          patch({ record: next });
        }}
        // A question or permission has no send-back note; only a check card does.
        sendBackNote=""
        onSendBackNote={() => undefined}
        onNoteFocus={() => undefined}
        onSubmit={submit}
        // A question or permission always has options, so it is never dismissed.
        onDismiss={() => undefined}
        // The Workbench's keys move between pages; the card is answered with the pointer or ⌘↩ in its note.
        shortcuts={false}
      />
    </Box>
  );
}
