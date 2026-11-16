import type { ChatDto, Effort, FolderWhileHeld, ProjectId, ProjectViewDto } from '@10db/contracts';
import { Box, Group, Select, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import { Composer } from '../../conversation/composer';
import { composerPhase } from '../../conversation/composer-phase';
import { hasContent, type Draft } from '../../conversation/drafts';
import { ModelMenu } from '../../conversation/model-menu';
import { useProjectFolder } from '../../daemon/project-folder-queries';
import {
  useChatModels,
  useCreateChat,
  useRecentChats,
  useSessionStarts,
} from '../../daemon/chat-queries';
import type { FreshTab as FreshTabState } from './fresh-tabs';
import { keepingWords } from './kind-line';
import { RecentSessions } from './recent-sessions';
import { draftKey, useSessionDraft, type SendRequest } from './session-drafts';
import { StartFrom } from './start-from';

// Sessions UI spec §6.2: a tab that is not yet a chat. The chat is made at the first `@` or
// the first send, whichever comes first, and the tab is then replaced by it. A send that fails after the
// chat exists goes again from the chat's tab, so it never makes a second one.

/** A query's `@` is open when it ends the text and starts a word. */
const OPEN_MENTION = /(^|\s)@\S*$/u;

/** Under 640 px the composer's hint goes (sessions UI spec §7.11). */
const NARROW_QUERY = '(max-width: 639px)';

export interface FreshTabProps {
  readonly tab: FreshTabState;
  readonly projects: readonly ProjectViewDto[];
  readonly onProject: (projectId: ProjectId) => void;
  readonly onModel: (model: string | null, effort: Effort | null) => void;
  /** The chat exists: the screen replaces this tab with it and, when `send` is set, sends the draft there. */
  readonly onChatMade: (chat: ChatDto, send: SendRequest | null) => void;
  readonly onOpenRecent: (chat: ChatDto) => void;
}

export function FreshTab({
  tab,
  projects,
  onProject,
  onModel,
  onChatMade,
  onOpenRecent,
}: FreshTabProps) {
  const project = projects.find((p) => p.id === tab.projectId);
  const name = project?.name ?? 'this project';
  const narrow = useMediaQuery(NARROW_QUERY);
  const [draft, setDraft] = useSessionDraft(draftKey.fresh(tab.id));
  const models = useChatModels(tab.projectId);
  // An agent that can't search the web (`capabilities.webSearch`) is never said to.
  const web = models.data?.webSearch === true;
  const starts = useSessionStarts(tab.projectId);
  const recent = useRecentChats(tab.projectId);
  const create = useCreateChat();
  // Holders that would keep the new chat's first message from writing: Send asks before it runs.
  const keeping = keepingWords(null, useProjectFolder(tab.projectId));
  const [createError, setCreateError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  // The chat being made, shared by an `@` and a send that come together, so there is only ever one.
  const making = useRef<{ promise: Promise<ChatDto>; want: { send: SendRequest | null } } | null>(
    null,
  );

  useEffect(() => {
    input.current?.focus();
  }, [tab.id]);

  const ensureChat = (send: SendRequest | null): Promise<ChatDto> => {
    if (making.current !== null) {
      making.current.want.send ??= send;
      return making.current.promise;
    }
    const want = { send };
    const promise = create
      .mutateAsync({
        projectId: tab.projectId,
        model: tab.model,
        effort: tab.effort,
        tabPosition: tab.position,
      })
      .then((chat) => {
        onChatMade(chat, want.send);
        return chat;
      })
      .finally(() => {
        making.current = null;
      });
    making.current = { promise, want };
    return promise;
  };

  const changeDraft = (next: Draft): void => {
    setDraft(next);
    setCreateError(null);
    if (!OPEN_MENTION.test(next.text)) return;
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

  return (
    <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <Box maw={720} mx="auto" px="md" pt="12vh" pb="xl">
        <Text size="sm" c="dimmed" mb="md">
          {web
            ? `A chat reads ${name}, runs commands and searches the web.`
            : `A chat reads ${name} and runs commands.`}
        </Text>
        <Group gap="sm" mb={4} wrap="wrap">
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
        <Text size="xs" c="dimmed" mb="sm">
          {web
            ? `Uses ${name}'s account. Reads the code, runs commands and searches the web. Asks before anything that crosses a limit.`
            : `Uses ${name}'s account. Reads the code and runs commands. Asks before anything that crosses a limit.`}
        </Text>
        <Box mx="calc(var(--mantine-spacing-md) * -1)">
          <Composer
            draft={draft}
            onDraft={changeDraft}
            capabilities={{ images: [] }}
            phase={phase}
            disabledReason={null}
            error={createError}
            inputRef={input}
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
            {...(keeping === null
              ? {}
              : {
                  held: {
                    holders: keeping,
                    onChoose: async (_draft: Draft, choice: FolderWhileHeld) => {
                      await ensureChat({ folder: choice });
                    },
                  },
                })}
            onSend={async () => {
              await ensureChat({});
            }}
            onStop={() => undefined}
            onRedo={() => undefined}
          />
        </Box>
        <Box mt="md">
          <StartFrom
            starts={starts}
            onPick={(text) => {
              setDraft({ ...draft, text });
              input.current?.focus();
            }}
          />
        </Box>
        <Box mt="lg">
          <RecentSessions chats={recent} onOpen={onOpenRecent} />
        </Box>
      </Box>
    </Box>
  );
}
