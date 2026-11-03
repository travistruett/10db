import {
  ShapeMessageAuthor,
  type ProjectId,
  type ShapeId,
  type ShapeViewDto,
} from '@10db/contracts';
import { Box, Group, Loader, Text } from '@mantine/core';
import {
  useCreateShape,
  useProposeShape,
  useSendShapeMessage,
  useStopShape,
  useUploadShapeFile,
} from '../../daemon/shape-queries';
import { Composer } from './composer';
import { addFiles } from './dropped-files';
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
    if (canPropose && !(view?.turn.proposing ?? false)) propose.mutate(shapeId);
  };
  const doStop = (): void => {
    if (shapeId !== null) stop.mutate(shapeId);
  };
  useShapeKeys({ onPropose: doPropose, onStop: doStop, answering });

  return (
    <Box
      component="section"
      aria-label="Conversation"
      h="100%"
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}
    >
      <Group px="md" pt="md" pb="xs" gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
        <Text size="sm" fw={500} lineClamp={1}>
          {view?.shape.title ?? 'New conversation'}
        </Text>
        {loading ? <Loader size="xs" aria-label="Loading the conversation" /> : null}
      </Group>
      <Transcript messages={view?.messages ?? []} why={why} />
      <Composer
        firstRun={!heardBuilder}
        answering={answering}
        proposing={(view?.turn.proposing ?? false) || propose.isPending}
        proposeLabel={(view?.shape.round ?? 0) > 0 ? 'Propose Again' : 'Propose'}
        canPropose={canPropose}
        error={error}
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
    </Box>
  );
}
