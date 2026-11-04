import {
  ShapeMessageAuthor,
  type ProjectId,
  type ShapeId,
  type ShapeViewDto,
} from '@10db/contracts';
import { Box, Button, Group, Loader, Text, Title } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import {
  useCreateShape,
  useProposeShape,
  useSendShapeMessage,
  useStopShape,
  useUploadShapeFile,
} from '../../daemon/shape-queries';
import { formatTokens } from '../factory/format-tokens';
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

  // The conversation a first send or drop made, held as the promise of its create so a send and a
  // drop that overlap share one create instead of leaving an empty conversation behind. The screen
  // opens it only once the send succeeds, so a retry after a failure reuses it. A failed create is
  // forgotten, so the retry makes it again. It is remembered with its project: switching project
  // stays on this screen, and a send there must start that project's conversation, not post into
  // the old one.
  const created = useRef<{
    readonly projectId: ProjectId | null;
    readonly id: Promise<ShapeId>;
  } | null>(null);
  const ensureId = (): Promise<ShapeId> => {
    if (shapeId !== null) return Promise.resolve(shapeId);
    if (created.current?.projectId === projectId) return created.current.id;
    const id = create.mutateAsync().then((made) => made.id);
    const entry = { projectId, id };
    created.current = entry;
    id.catch(() => {
      if (created.current === entry) created.current = null;
    });
    return id;
  };

  const answering = view?.turn.running ?? false;
  const heardBuilder = view?.messages.some((m) => m.author === ShapeMessageAuthor.Builder) ?? false;
  const canPropose = shapeId !== null && heardBuilder;

  const doPropose = (): void => {
    if (canPropose && !(view?.turn.proposing ?? false)) {
      // Only a refusal is cleared: resetting a pending Stop would lose its outcome.
      if (stop.isError) stop.reset();
      propose.mutate(shapeId);
    }
  };
  const queued = view?.turn.queued ?? 0;
  // The longest the queue has been since Stop was pressed. The view has no turn id and `running`
  // stays true from one queued turn to the next, so the queue falling is what says a turn ended.
  const queuedSinceStop = useRef(0);
  const doStop = (): void => {
    if (shapeId !== null) {
      if (propose.isError) propose.reset();
      queuedSinceStop.current = queued;
      stop.mutate(shapeId);
    }
  };
  // A refused Stop was about the turn that was running. Once that turn has ended the refusal is out
  // of date, so it goes without a send; one still pending is left alone, since resetting it would
  // detach the observer and lose its outcome.
  const stopRefused = stop.isError;
  const resetStop = stop.reset;
  useEffect(() => {
    if (queued > queuedSinceStop.current) queuedSinceStop.current = queued;
    if (stopRefused && (!answering || queued < queuedSinceStop.current)) resetStop();
  }, [stopRefused, answering, queued, resetStop]);
  // The latest mutations, for a send that started before they changed.
  const latest = useRef({ propose, stop });
  useEffect(() => {
    latest.current = { propose, stop };
  });

  // A load failure is what the screen is in now, so it comes first; a refused Propose or Stop is the
  // daemon's words in the same alert.
  const shownError = error ?? propose.error?.message ?? stop.error?.message ?? null;
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
          {shapeId !== null && (view?.tokens ?? 0) > 0 ? (
            <Text size="xs" c="dimmed" style={{ flex: 'none', whiteSpace: 'nowrap' }}>
              {formatTokens(view?.tokens ?? 0)} tokens
            </Text>
          ) : null}
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
              made.id ??= await ensureId();
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
          const before = latest.current;
          const id = await ensureId();
          await send.mutateAsync({ shapeId: id, text });
          // The daemon took the message, so a refusal of Propose or Stop from before the send is out
          // of date. Only that one is cleared: `mutateAsync` settles after the refetch, so a refusal
          // that arrived during the send is news, and a Propose or Stop still in flight keeps its
          // observer, so its loading state lasts and a refusal that comes later is shown.
          const { propose: nowPropose, stop: nowStop } = latest.current;
          if (nowPropose.isError && nowPropose.error === before.propose.error) nowPropose.reset();
          if (nowStop.isError && nowStop.error === before.stop.error) nowStop.reset();
          if (shapeId === null) onOpened(id);
        }}
        onPropose={doPropose}
        onStop={doStop}
      />
      {shapeId === null ? <RecentConversations projectId={projectId} /> : null}
    </Box>
  );
}
