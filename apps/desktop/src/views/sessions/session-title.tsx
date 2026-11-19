import type { ChatDto, ConversationDto } from '@10db/contracts';
import { ActionIcon, Box, Menu, Text, TextInput } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useRef, useState, type ReactNode } from 'react';
import { ContextRing } from '../../conversation/context-ring';
import { OWNS_ESCAPE_ATTRIBUTE } from '../../conversation/escape';
import { usePatchChat } from '../../daemon/chat-queries';
import { TitleRow } from '../../shell/title-row';
import { canOpenTerminal } from './can-open-terminal';
import { SessionMenuItems, type SessionActions } from './session-menu';
import { TerminalButton } from './terminal-button';

const CONTEXT_TIP = 'Past 70%, the next turn continues in a fresh session with a summary.';

export interface SessionTitleProps {
  readonly chat: ChatDto;
  readonly conversation: ConversationDto;
  /** Where the session works and what changed, in git's words. */
  readonly meta: string | null;
  /** The ⌄ switcher. */
  readonly switcher: ReactNode;
  /** The project's folder; null once the project was removed from 10db. */
  readonly projectPath: string | null;
  /** What the menus do; Rename edits the title in place and the terminal opens its popover. */
  readonly actions: Omit<SessionActions, 'onRename' | 'onOpenInTerminal'>;
  /** The builder asked to rename from the panel. */
  readonly renaming?: boolean;
  readonly onRenamed?: () => void;
  /** The builder asked to open the session in a terminal from the panel. */
  readonly openingTerminal?: boolean;
  readonly onTerminalAsked?: () => void;
  /** The clipboard refused the open's command; the banner shows it. */
  readonly onTerminalUncopied?: (line: string) => void;
  /** Controls between the context ring and the terminal button: Changes and the git step. */
  readonly steps?: ReactNode;
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
        component="span"
        inherit
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

/**
 * A session's title row (sessions spec §6.5): the title, the ⌄ switcher, the meta line, then the agent and
 * its model, the context ring, Changes and the git step, the terminal button and ⋯.
 */
export function SessionTitle({
  chat,
  conversation,
  meta,
  switcher,
  projectPath,
  actions,
  renaming = false,
  onRenamed,
  openingTerminal = false,
  onTerminalAsked,
  onTerminalUncopied,
  steps,
}: SessionTitleProps) {
  const [typing, setEditing] = useState(false);
  const [askedHere, setAskedHere] = useState(false);
  const editing = typing || renaming;
  const { capabilities } = conversation;
  // Only a session the agent can take to a terminal, and not one in it already or sealed.
  const offersTerminal = projectPath !== null && canOpenTerminal(conversation);
  const terminalOpen = offersTerminal && (askedHere || openingTerminal);
  return (
    <TitleRow
      title={
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
      }
      switcher={switcher}
      meta={meta}
      actions={
        <>
          <Text size="xs" c="dimmed" component="span" visibleFrom="md">
            {capabilities.label}
          </Text>
          {conversation.model === null ? null : (
            <Text size="xs" c="dimmed" component="span" visibleFrom="md">
              {conversation.model}
            </Text>
          )}
          <ContextRing
            percent={conversation.contextPct}
            more={[
              CONTEXT_TIP,
              ...(conversation.costUsd === null
                ? []
                : [`$${conversation.costUsd.toFixed(2)} so far`]),
            ]}
          />
          {steps}
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
              <SessionMenuItems
                actions={{
                  ...actions,
                  onRename: () => {
                    setEditing(true);
                  },
                  // Open in Terminal is the terminal button beside this menu, so the menu leaves it out.
                }}
              />
            </Menu.Dropdown>
          </Menu>
        </>
      }
    />
  );
}
