import type { ProjectViewDto, TaskSessionDto } from '@10db/contracts';
import { Anchor, Box, Button, Group, Text, Textarea } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { ConversationList } from '../../conversation';
import { ConversationLayout } from '../../conversation/conversation-layout';
import { itemEntries } from '../../conversation/item-entries';
import type { ConversationEntry } from '../../conversation/entry';
import {
  useConversationItemsState,
  useConversationLive,
  useToolCallFull,
} from '../../daemon/conversation-queries';
import { usePostTaskMessage } from '../../daemon/pass-queries';
import { useTasks, useWorkstreams } from '../../daemon/queries';
import { ExternalLink } from '../board/pull-request-link';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { useOpenSession } from './open-session';
import { withQuote } from './changes-files';
import type { Quote } from './quote';
import { TASK_BAR_BUTTON, TaskBar } from './task-bar';
import { copyFooter } from './task-tab-words';

// Sessions UI §8.2, §8.4, §8.5: a separate copy's tab. The chat it came from, the brief as the builder's first
// message, then the task's thread, and one line for where the run stands. It lands by the project's delivery,
// so it has no Sign Off.

const NO_REPLIES = '';

export interface CopyTabProps {
  readonly session: TaskSessionDto;
  readonly project: ProjectViewDto | undefined;
  /** The bar's Changes control, from the tab that owns the panel. */
  readonly changes?: ReactNode;
  /** A line quoted from Changes, to add to the composer once. */
  readonly quote?: Quote | null;
}

export function CopyTab({ session, project, changes, quote = null }: CopyTabProps) {
  const { items, loading } = useConversationItemsState(session.conversationId);
  const live = useConversationLive(session.conversationId);
  const loadFull = useToolCallFull(session.conversationId, items);
  const tasks = useTasks(project?.id ?? null);
  const workstreams = useWorkstreams({ active: false });
  const openSession = useOpenSession();
  const task = tasks.data?.find((t) => t.id === session.taskId);
  const workstream = workstreams.data?.find((w) => w.id === session.workstreamId);
  const footer = copyFooter(session, workstream);

  const entries: ConversationEntry[] = [
    ...(session.fromChat === null
      ? []
      : [
          {
            kind: 'custom' as const,
            id: 'from-chat',
            render: () => {
              const from = session.fromChat;
              if (from === null || project === undefined) return null;
              return (
                <Anchor
                  component="button"
                  type="button"
                  size="xs"
                  c="dimmed"
                  onClick={() => {
                    void openSession(from.chatId, project.id);
                  }}
                >
                  From chat: {from.title}
                </Anchor>
              );
            },
          },
        ]),
    ...(task === undefined || task.description === ''
      ? []
      : [{ kind: 'builder' as const, id: 'brief', text: task.description, extra: null }]),
    ...itemEntries(items, live, {
      sendNow: () => undefined,
      label: 'The task',
      receipts: false,
      working: footer.kind === 'running',
      cards: [],
    }),
  ];

  return (
    <ConversationLayout
      label="Task"
      header={
        <TaskBar
          title={session.title}
          taskId={session.taskId}
          kindLine={`Task · Separate copy${session.branch === null ? '' : ` · \`${session.branch}\``}`}
          actions={changes}
        />
      }
      footer={<CopyFooter session={session} footer={footer} quote={quote} />}
    >
      {loading ? (
        <Box px="md" pt="md">
          <PageLoading shape={PageLoadingShape.Lines} label="Loading the task" />
        </Box>
      ) : null}
      <ConversationList
        entries={entries}
        highlight={null}
        loadFull={loadFull}
        onAllow={() => undefined}
        agentLabel="The task"
        busy={footer.kind === 'running'}
      />
    </ConversationLayout>
  );
}

function CopyFooter({
  session,
  footer,
  quote,
}: {
  readonly session: TaskSessionDto;
  readonly footer: ReturnType<typeof copyFooter>;
  readonly quote: Quote | null;
}) {
  const [text, setText] = useState(NO_REPLIES);
  // A quote from Changes lands in the message once, however often this renders.
  const [quoted, setQuoted] = useState(0);
  if (quote !== null && quote.id !== quoted) {
    setQuoted(quote.id);
    setText(withQuote(text, quote.text));
  }
  const post = usePostTaskMessage(session.taskId);
  if (footer.kind === 'running')
    return (
      <Group px="md" py="sm" gap="xs" align="flex-end" wrap="nowrap">
        <Textarea
          aria-label="Message"
          placeholder="Messages reach this task while it runs."
          autosize
          minRows={1}
          maxRows={6}
          style={{ flex: 1 }}
          value={text}
          error={post.error?.message}
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
        />
        <Button
          disabled={text.trim() === ''}
          loading={post.isPending}
          onClick={() => {
            post.mutate(
              { text: text.trim(), pictures: [] },
              {
                onSuccess: () => {
                  setText(NO_REPLIES);
                },
              },
            );
          }}
        >
          Send
        </Button>
      </Group>
    );
  return (
    <Group px="md" py="sm" gap="sm" wrap="nowrap" role="status">
      <Text size="sm" {...(footer.kind === 'failed' ? { c: 'red' } : {})} style={{ flex: 1 }}>
        {footer.text}
      </Text>
      {footer.kind === 'in_review' || footer.kind === 'failed' || footer.kind === 'waiting' ? (
        <Button
          {...TASK_BAR_BUTTON}
          renderRoot={(props) => <Link {...props} to="/board" search={{ task: session.taskId }} />}
        >
          Open on Board
        </Button>
      ) : null}
      {footer.kind === 'in_review' && footer.pullRequest !== null ? (
        <ExternalLink url={footer.pullRequest} label="Open Pull Request" />
      ) : null}
    </Group>
  );
}
