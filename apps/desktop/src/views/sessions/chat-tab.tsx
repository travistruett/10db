import type { ChatDto } from '@10db/contracts';
import { Box } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import { ConversationList, WorkingLine } from '../../conversation';
import { Composer } from '../../conversation/composer';
import { composerPhase } from '../../conversation/composer-phase';
import { EMPTY_DRAFT, hasContent, type Draft } from '../../conversation/drafts';
import { itemEntries } from '../../conversation/item-entries';
import {
  useConversation,
  useConversationItems,
  useConversationLive,
  useSendConversationMessage,
  useStopConversation,
  useRedoConversation,
  useSendNow,
} from '../../daemon/conversation-queries';
import { draftKey, sessionDrafts, useSessionDraft } from './session-drafts';

const NARROW_QUERY = '(max-width: 639px)';

/** A chat's conversation: its transcript, what streams and the composer. */
export function ChatTab({
  chat,
  projectName,
}: {
  readonly chat: ChatDto;
  readonly projectName: string;
}) {
  const conversationQuery = useConversation(chat.conversationId);
  const conversation = conversationQuery.data ?? chat.conversation;
  const items = useConversationItems(chat.conversationId);
  const live = useConversationLive(chat.conversationId);
  const narrow = useMediaQuery(NARROW_QUERY);
  const key = draftKey.chat(chat.id);
  const [draft, setDraft] = useSessionDraft(key);
  const send = useSendConversationMessage();
  const stop = useStopConversation();
  const redo = useRedoConversation();
  const sendNow = useSendNow();
  const [sendError, setSendError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const caps = conversation.capabilities;

  const post = async (d: Draft): Promise<void> => {
    await send.mutateAsync({
      conversationId: chat.conversationId,
      text: d.text,
      mentions: d.mentions,
      pictures: d.pictures,
    });
  };

  // A chat made by a send in a fresh tab sends that draft as soon as it is drawn; a failure leaves the
  // draft here, so the next send goes to this conversation and never to a second chat.
  useEffect(() => {
    if (!sessionDrafts.takeSendRequest(key)) return;
    post(sessionDrafts.get(key))
      .then(() => {
        sessionDrafts.set(key, EMPTY_DRAFT);
      })
      .catch((error: unknown) => {
        setSendError(error instanceof Error ? error.message : String(error));
      });
    // The request is taken once per tab; `post` is the tab's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const entries = itemEntries(items, live, {
    sendNow: () => {
      sendNow.mutate(chat.conversationId);
    },
    label: caps.label,
    receipts: caps.receipts,
    working: conversation.state === 'running' || conversation.state === 'starting',
    cards: [],
  });
  const phase = composerPhase({
    state: conversation.state,
    hasText: hasContent(draft),
    steer: caps.steer,
    project: projectName,
    fresh: false,
    narrow,
    slashCommands: caps.slashCommands,
  });

  return (
    <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Box
        maw={720}
        w="100%"
        mx="auto"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <ConversationList entries={entries} highlight={null} agentLabel={caps.label} />
        <WorkingLine conversation={conversation} streaming={null} />
        <Composer
          draft={draft}
          onDraft={(next) => {
            setSendError(null);
            setDraft(next);
          }}
          capabilities={caps}
          phase={phase}
          disabledReason={null}
          error={sendError}
          inputRef={input}
          onSend={post}
          onStop={() => {
            stop.mutate(chat.conversationId);
          }}
          onRedo={async (d) => {
            await redo.mutateAsync({ conversationId: chat.conversationId, text: d.text });
          }}
        />
      </Box>
    </Box>
  );
}
