import type { ChatDto, Effort, ProjectId, ProjectViewDto } from '@10db/contracts';
import { Alert, Box, Button, Container, Group, Select, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import { Composer } from '../../conversation/composer';
import { addFiles } from '../../conversation/dropped-files';
import { ContentWidth } from '../../shell/content-width';
import { composerPhase } from '../../conversation/composer-phase';
import { applyDraftChange, hasContent, type DraftChange } from '../../conversation/drafts';
import { ModelMenu } from '../../conversation/model-menu';
import { useChatModels, useCreateChat } from '../../daemon/chat-queries';
import { useUploadShapeFile } from '../../daemon/shape-queries';
import { dropNotes } from './plan/drop-notes';
import { PlanSide } from './plan/plan-side';
import { planChoice, usePlanOpen } from './plan/plan-choice';
import type { FreshTab as FreshTabState } from './fresh-tabs';
import { draftKey, sessionDrafts, useSessionDraft, type SendRequest } from './session-drafts';

// Sessions UI spec §6.2: a tab that is not yet a chat. The chat is made at the first `@` or
// the first send, whichever comes first, and the tab is then replaced by it. A send that fails after the
// chat exists goes again from the chat's tab, so it never makes a second one.

/** A query's `@` is open when it ends the text and starts a word. */
const OPEN_MENTION = /(^|\s)@\S*$/u;

/** Under 640 px the composer's hint goes (sessions UI spec §7.11). */
/** Under this width of the tab itself the composer drops its long labels. */
const NARROW_PX = 640;

export interface FreshTabProps {
  readonly tab: FreshTabState;
  /** Where the chat made from this tab goes among the open ones: the top of its project. */
  readonly tabPosition: number;
  readonly projects: readonly ProjectViewDto[];
  readonly onProject: (projectId: ProjectId) => void;
  readonly onModel: (model: string | null, effort: Effort | null) => void;
  /** The chat exists: the screen replaces this tab with it and, when `send` is set, sends the draft there. */
  readonly onChatMade: (chat: ChatDto, send: SendRequest | null) => void;
}

export function FreshTab({
  tab,
  tabPosition,
  projects,
  onProject,
  onModel,
  onChatMade,
}: FreshTabProps) {
  const project = projects.find((p) => p.id === tab.projectId);
  const name = project?.name ?? 'this project';
  // The tab's own width, not the window's; an unmeasured tab reads 0 and is not narrow.
  const { ref: sizeRef, width } = useElementSize();
  const narrow = width > 0 && width < NARROW_PX;
  const [draft, setDraft] = useSessionDraft(draftKey.fresh(tab.id));
  const models = useChatModels(tab.projectId);
  const create = useCreateChat();
  const upload = useUploadShapeFile();
  const [createError, setCreateError] = useState<string | null>(null);
  // Files dropped before the session exists: kept until it does, and after a failed create.
  const [held, setHeld] = useState<readonly File[]>([]);
  const heldNow = useRef<File[]>([]);
  const planOpen = usePlanOpen(tab.id, tab.plan);
  const input = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  // The chat being made, shared by an `@` and a send that come together, so there is only ever one.
  const making = useRef<{
    promise: Promise<ChatDto>;
    want: { send: SendRequest | null; files: File[] };
  } | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, [tab.id]);

  // A second send or drop while the session is being made waits for it, then goes in order: files first
  // (the session's plan exists by then), then the message.
  // Files not yet in a session stay held, so a create that failed still has them when the next send, drop or
  // `@` starts one, and none is held twice.
  const ensureChat = (send: SendRequest | null, files: readonly File[] = []): Promise<ChatDto> => {
    const fresh = files.filter((file) => !heldNow.current.includes(file));
    heldNow.current.push(...fresh);
    if (fresh.length > 0) setHeld([...heldNow.current]);
    if (making.current !== null) {
      making.current.want.send ??= send;
      making.current.want.files.push(...fresh);
      return making.current.promise;
    }
    const want = { send, files: [...heldNow.current] };
    const promise = create
      .mutateAsync({
        projectId: tab.projectId,
        model: tab.model,
        effort: tab.effort,
        tabPosition,
        ...(tab.plan ? { plan: true } : {}),
      })
      .then(async (chat) => {
        const reasons: string[] = [];
        let uploaded = 0;
        for (let next = want.files.shift(); next !== undefined; next = want.files.shift()) {
          const { planId } = chat;
          reasons.push(
            ...(await addFiles([next], uploaded, {
              ensureConversation: () => Promise.resolve(),
              upload: (file) =>
                planId === null
                  ? Promise.reject(new Error('This session has no plan to add files to.'))
                  : upload.mutateAsync({ shapeId: planId, file }),
            })),
          );
          uploaded += 1;
        }
        dropNotes.leave(chat.id, reasons);
        onChatMade(chat, want.send);
        return chat;
      })
      .finally(() => {
        making.current = null;
      });
    making.current = { promise, want };
    return promise;
  };

  const changeDraft = (change: DraftChange): void => {
    const next = applyDraftChange(sessionDrafts.get(draftKey.fresh(tab.id)), change);
    setDraft(next);
    setCreateError(null);
    if (!OPEN_MENTION.test(next.text)) return;
    ensureChat(null).catch((error: unknown) => {
      setCreateError(error instanceof Error ? error.message : String(error));
    });
  };

  const tryAgain = (): void => {
    setCreateError(null);
    // The draft stays where it is and moves to the session with the tab; the builder sends it from there.
    ensureChat(null).catch((error: unknown) => {
      setCreateError(error instanceof Error ? error.message : String(error));
    });
  };

  const phase = composerPhase({
    state: 'idle_cold',
    hasText: hasContent(draft),
    steer: 'inject',
    project: name,
    fresh: true,
    narrow: narrow,
  });
  const chosen = create.isPending;

  const conversation = (
    <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
      <Container size={ContentWidth.Reading} px="md" pt="12vh" pb="xl">
        {tab.plan ? (
          <Text size="sm" c="dimmed" mb="md">
            {`Plan in ${name}: talk it through, or drop a document. The plan fills in beside the conversation.`}
          </Text>
        ) : null}
        <Group gap="sm" mb="sm" wrap="wrap">
          <Select
            aria-label="Project"
            placeholder="Find a project"
            size="xs"
            w={220}
            searchable
            allowDeselect={false}
            disabled={chosen}
            data={projects.map((p) => ({ value: p.id, label: p.name }))}
            value={tab.projectId}
            onChange={(value) => {
              const next = projects.find((p) => p.id === value);
              if (next !== undefined) onProject(next.id);
            }}
          />
        </Group>
        <Box mx="calc(var(--mantine-spacing-md) * -1)">
          <Composer
            draft={draft}
            onDraft={changeDraft}
            capabilities={{ images: [] }}
            phase={phase}
            disabledReason={null}
            error={null}
            // The alert under the composer says why, once, and offers Try Again.
            onFailure={setCreateError}
            inputRef={input}
            {...(tab.plan
              ? {
                  uploads: {
                    onFiles: (files: File[]) => {
                      setCreateError(null);
                      ensureChat(null, files).catch((error: unknown) => {
                        setCreateError(error instanceof Error ? error.message : String(error));
                      });
                    },
                    refused: [],
                    onDismiss: () => undefined,
                  },
                }
              : {})}
            modelControl={
              models.data === undefined ? null : (
                <ModelMenu
                  offered={models.data.offered}
                  default={models.data.default}
                  picked={tab.model}
                  effort={tab.effort}
                  busy={false}
                  pending={chosen}
                  onPick={onModel}
                />
              )
            }
            onSend={async (sent) => {
              await ensureChat({ draft: sent });
            }}
            onStop={() => undefined}
            onRedo={() => undefined}
          />
        </Box>
        {held.length === 0 ? null : (
          <Text size="xs" c="dimmed" mt="xs" aria-label="Files waiting for the session">
            {held.map((f) => f.name).join(' · ')}
          </Text>
        )}
        {createError === null ? null : (
          <Alert color="red" mt="sm" py={6} role="alert">
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm">{createError}</Text>
              <Button size="compact-xs" variant="default" loading={chosen} onClick={tryAgain}>
                Try Again
              </Button>
            </Group>
          </Alert>
        )}
      </Container>
    </Box>
  );

  return (
    <Box ref={sizeRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' }}>
      {tab.plan ? (
        <PlanSide
          open={planOpen}
          width={width}
          shapeId={null}
          onClose={() => {
            planChoice.set(tab.id, false);
          }}
          onWhy={() => undefined}
          onAskForChanges={() => undefined}
        >
          {conversation}
        </PlanSide>
      ) : (
        conversation
      )}
    </Box>
  );
}
