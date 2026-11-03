import {
  ShapeMessageAuthor,
  type ProjectId,
  type ShapeId,
  type ShapeViewDto,
} from '@10db/contracts';
import { Box, Button, Group, Loader, Text, Title } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import {
  useCreateShape,
  useProposeShape,
  useSendShapeMessage,
  useStopShape,
  useUploadShapeFile,
} from '../../daemon/shape-queries';
import { Composer } from './composer';
import { addFiles } from './dropped-files';
import { HistoryButton } from './history-button';
import { RecentConversations } from './recent-conversations';
import { Transcript, type TranscriptProps } from './transcript';
import { useShapeKeys } from './use-shape-keys';

export interface ConversationPaneProps {
  readonly projectId: ProjectId | null;
  /** The open conversation; null on the new-conversation screen, which makes one on the first send. */
  readonly shapeId: ShapeId | null;
  readonly view: ShapeViewDto | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  /** Told the id of a conversation the first send made, to open it. */
  readonly onOpened: (shapeId: ShapeId) => void;
  /** The messages a row's Why? points at. */
  readonly why: TranscriptProps['why'];
}

/** Left: the conversation's title, its transcript and the input. */
export function ConversationPane({
  projectId,
  shapeId,
  view,
  loading,
  error,
  onOpened,
  why,
}: ConversationPaneProps) {
  const create = useCreateShape(projectId);
  const send = useSendShapeMessage();
  const propose = useProposeShape();
  const stop = useStopShape();
  const upload = useUploadShapeFile();

  const answering = view?.turn.running ?? false;
  const heardBuilder = view?.messages.some((m) => m.author === ShapeMessageAuthor.Builder) ?? false;
  const canPropose = shapeId !== null && heardBuilder;

  const doPropose = (): void => {
    if (canPropose && !(view?.turn.proposing ?? false)) {
      stop.reset();
      propose.mutate(shapeId);
    }
  };
  const doStop = (): void => {
    if (shapeId !== null) {
      propose.reset();
      stop.mutate(shapeId);
    }
  };
  // A refused Propose or Stop is the daemon's words in the same alert as a load failure.
  const shownError = propose.error?.message ?? stop.error?.message ?? error;
  useShapeKeys({ onPropose: doPropose, onStop: doStop, answering });

  return (
    <Box
      component="section"
      aria-label="Conversation"
      h="100%"
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}
    >
      <Group
        px="md"
        pt="md"
        pb="xs"
        gap="sm"
        wrap="nowrap"
        justify="space-between"
        style={{ flex: 'none' }}
      >
        <Group gap="sm" wrap="nowrap" miw={0}>
          <Title order={2} size="h4">
            Plan
          </Title>
          {shapeId === null ? null : (
            <Text size="sm" fw={500} lineClamp={1}>
              {view?.shape.title}
            </Text>
          )}
          {loading && shapeId !== null ? (
            <Loader size="xs" aria-label="Loading the conversation" />
          ) : null}
        </Group>
        {shapeId === null ? null : (
          <Group gap="xs" wrap="nowrap">
            <Button
              component={Link}
              to="/shape"
              variant="default"
              size="xs"
              leftSection={<IconPlus size={14} stroke={1.5} />}
            >
              New
            </Button>
            <HistoryButton projectId={projectId} current={shapeId} />
          </Group>
        )}
      </Group>
      <Transcript messages={view?.messages ?? []} why={why} />
      <Composer
        firstRun={!heardBuilder}
        answering={answering}
        proposing={(view?.turn.proposing ?? false) || propose.isPending}
        proposeLabel={(view?.shape.round ?? 0) > 0 ? 'Propose Again' : 'Propose'}
        canPropose={canPropose}
        error={shownError}
        files={(view?.files ?? []).map((f) => f.name)}
        onFiles={async (dropped) => {
          // A drop into a conversation that doesn't exist yet starts it, as the first message does.
          const made: { id: ShapeId | null } = { id: shapeId };
          const problems = await addFiles(dropped, view?.files.length ?? 0, {
            ensureConversation: async () => {
              made.id ??= (await create.mutateAsync()).id;
            },
            upload: (file) => {
              if (made.id === null) return Promise.reject(new Error('No conversation to add to.'));
              return upload.mutateAsync({ shapeId: made.id, file });
            },
          });
          if (shapeId === null && made.id !== null) onOpened(made.id);
          return problems;
        }}
        onSend={async (text) => {
          const id = shapeId ?? (await create.mutateAsync()).id;
          await send.mutateAsync({ shapeId: id, text });
          if (shapeId === null) onOpened(id);
        }}
        onPropose={doPropose}
        onStop={doStop}
      />
      {shapeId === null ? <RecentConversations projectId={projectId} /> : null}
    </Box>
  );
}
