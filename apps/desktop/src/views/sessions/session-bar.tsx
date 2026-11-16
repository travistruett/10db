import type { ChatDto, ConversationDto, FolderDto } from '@10db/contracts';
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { JudgeLine } from '../../conversation';
import { OWNS_ESCAPE_ATTRIBUTE } from '../../conversation/escape';
import { usePatchChat } from '../../daemon/chat-queries';
import { canOpenTerminal } from './can-open-terminal';
import { kindLine } from './kind-line';
import { TabMenuItems, type TabActions } from './tab-menu';
import { TerminalButton } from './terminal-button';

// Sessions UI spec §4, §7.10: the 44 px row under the header. At its left the title over what the session
// is; at its right the agent's name, File as Tasks and the ⋯ menu. The model's menu and the
// context ring are the composer's.

export interface SessionBarProps {
  readonly chat: ChatDto;
  readonly conversation: ConversationDto;
  readonly projectName: string;
  /** Who holds Your folder, once read. */
  readonly folder: FolderDto | null;
  /** The project's folder; null once the project was removed from 10db. */
  readonly projectPath: string | null;
  /** When the chat went to the builder's terminal, once read. */
  readonly terminalSince?: string | null;
  /** The transcript is still being read. */
  readonly loading: boolean;
  /** File as Tasks, disabled with this reason when it cannot be sent. */
  readonly fileDisabledReason: string | null;
  readonly onFileAsTasks: () => void;
  /** What the ⋯ menu does for the tab; Rename edits the title in place. */
  readonly actions?: Omit<TabActions, 'onRename'>;
  /** The builder asked to rename from the strip. */
  readonly renaming?: boolean;
  readonly onRenamed?: () => void;
  /** The builder asked to open the chat in a terminal from the strip. */
  readonly openingTerminal?: boolean;
  readonly onTerminalAsked?: () => void;
  /** The clipboard refused the open's command; the banner shows it. */
  readonly onTerminalUncopied?: (line: string) => void;
}

/** The title, edited in place: Enter saves through `usePatchChat`, Esc puts the old one back. */
function Title({
  chat,
  editing,
  onDone,
  onEdit,
}: {
  readonly chat: ChatDto;
  readonly editing: boolean;
  readonly onDone: () => void;
  readonly onEdit: () => void;
}) {
  const patch = usePatchChat();
  const [draft, setDraft] = useState(chat.title);
  const finished = useRef(false);
  if (!editing) {
    return (
      <Text
        fw={600}
        size="sm"
        lineClamp={1}
        title="Double-click to rename"
        onDoubleClick={() => {
          setDraft(chat.title);
          finished.current = false;
          onEdit();
        }}
      >
        {chat.title}
      </Text>
    );
  }
  const save = (): void => {
    if (finished.current) return;
    finished.current = true;
    const title = draft.trim();
    if (title !== '' && title !== chat.title) patch.mutate({ chatId: chat.id, title });
    onDone();
  };
  return (
    <Box {...{ [OWNS_ESCAPE_ATTRIBUTE]: '' }}>
      <TextInput
        size="xs"
        aria-label="Session name"
        value={draft}
        ref={(field) => {
          // The field opens for typing: renaming starts with the cursor in it.
          field?.focus();
        }}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
        }}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finished.current = true;
            onDone();
          }
        }}
      />
    </Box>
  );
}

export function SessionBar({
  chat,
  conversation,
  projectName,
  folder,
  loading,
  fileDisabledReason,
  onFileAsTasks,
  actions,
  renaming = false,
  onRenamed,
  projectPath,
  terminalSince = null,
  openingTerminal = false,
  onTerminalAsked,
  onTerminalUncopied,
}: SessionBarProps) {
  const [typing, setEditing] = useState(false);
  const [askedHere, setAskedHere] = useState(false);
  const editing = typing || renaming;
  const { capabilities } = conversation;
  // Only a chat the agent can take to a terminal, and not one in it already or sealed.
  const offersTerminal = projectPath !== null && canOpenTerminal(conversation);
  const terminalOpen = offersTerminal && (askedHere || openingTerminal);
  return (
    <Box style={{ flex: 'none' }}>
      <Group h={44} px="md" justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          {loading ? <Loader size="xs" aria-label="Loading the session" /> : null}
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Title
              chat={chat}
              editing={editing}
              onEdit={() => {
                setEditing(true);
              }}
              onDone={() => {
                setEditing(false);
                onRenamed?.();
              }}
            />
            <Text size="xs" c="dimmed" lineClamp={1}>
              {kindLine(chat, projectName, folder, terminalSince)}
            </Text>
          </Stack>
        </Group>
        <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
          <Text size="xs" c="dimmed">
            {capabilities.label}
          </Text>
          <Tooltip label={fileDisabledReason ?? ''} disabled={fileDisabledReason === null}>
            <Button
              variant="default"
              size="xs"
              disabled={fileDisabledReason !== null}
              onClick={onFileAsTasks}
            >
              File as Tasks
            </Button>
          </Tooltip>
          {offersTerminal ? (
            <TerminalButton
              chat={chat}
              conversation={conversation}
              path={projectPath}
              opened={terminalOpen}
              onOpened={(opened) => {
                setAskedHere(opened);
                if (!opened) onTerminalAsked?.();
              }}
              onUncopied={(line) => onTerminalUncopied?.(line)}
            />
          ) : null}
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" aria-label="More session actions">
                <IconDots size={16} stroke={1.5} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <TabMenuItems
                actions={{
                  othersOpen: false,
                  onClose: () => undefined,
                  onCloseOthers: () => undefined,
                  ...actions,
                  onRename: () => {
                    setEditing(true);
                  },
                  ...(offersTerminal
                    ? {
                        onOpenInTerminal: () => {
                          setAskedHere(true);
                        },
                      }
                    : {}),
                }}
              />
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
      <JudgeLine judge={capabilities.judge} />
    </Box>
  );
}
