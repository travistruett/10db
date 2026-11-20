import type { ChatDto, ConversationDto } from '@10db/contracts';
import { ActionIcon, Box, Button, Menu, TextInput } from '@mantine/core';
import { IconDots, IconLayoutSidebarRight } from '@tabler/icons-react';
import { useRef, useState, type ReactNode } from 'react';
import { OWNS_ESCAPE_ATTRIBUTE } from '../../conversation/escape';
import { usePatchChat } from '../../daemon/chat-queries';
import { TitleRow } from '../../shell/title-row';
import { canOpenTerminal } from './can-open-terminal';
import { SessionMenuItems, type SessionActions } from './session-menu';
import { TerminalButton } from './terminal-button';

export interface SessionTitleProps {
  readonly chat: ChatDto;
  readonly conversation: ConversationDto;
  /** The title as the session switcher: the title and its chevron, one button that opens the session menu. */
  readonly switcherFor: (label: string) => ReactNode;
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
  /** Controls before the terminal button: the git step. */
  readonly steps?: ReactNode;
  /** A session with a plan: the Plan panel's toggle. */
  readonly plan?: { readonly open: boolean; readonly onToggle: () => void };
}

/** The title: the session switcher, or, while renaming, a field over it. */
function Title({
  chat,
  editing,
  onDone,
  switcherFor,
}: {
  readonly chat: ChatDto;
  readonly editing: boolean;
  readonly onDone: () => void;
  readonly switcherFor: (label: string) => ReactNode;
}) {
  if (!editing) return switcherFor(chat.title);
  return <TitleEditor chat={chat} onDone={onDone} />;
}

/** The title, edited in place: Enter saves through `usePatchChat`, Esc puts the old one back. */
function TitleEditor({ chat, onDone }: { readonly chat: ChatDto; readonly onDone: () => void }) {
  const patch = usePatchChat();
  // Mounted each time a rename starts, so the field opens on the title as it is now.
  const [draft, setDraft] = useState(chat.title);
  const finished = useRef(false);
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
 * A session's title row (sessions spec §6.5): the title as the switcher, taking the row up to the git step,
 * the terminal button and ⋯. Where the session works, its agent, context and changes are the strip under the
 * composer (`session-strip.tsx`).
 */
export function SessionTitle({
  chat,
  conversation,
  switcherFor,
  projectPath,
  actions,
  renaming = false,
  onRenamed,
  openingTerminal = false,
  onTerminalAsked,
  onTerminalUncopied,
  steps,
  plan,
}: SessionTitleProps) {
  const [typing, setEditing] = useState(false);
  const [askedHere, setAskedHere] = useState(false);
  const editing = typing || renaming;
  // Only a session the agent can take to a terminal, and not one in it already or sealed.
  const offersTerminal = projectPath !== null && canOpenTerminal(conversation);
  const terminalOpen = offersTerminal && (askedHere || openingTerminal);
  return (
    <TitleRow
      title={
        <Title
          chat={chat}
          editing={editing}
          switcherFor={switcherFor}
          onDone={() => {
            setEditing(false);
            onRenamed?.();
          }}
        />
      }
      actions={
        <>
          {plan === undefined ? null : (
            <Button
              variant={plan.open ? 'light' : 'default'}
              size="xs"
              aria-pressed={plan.open}
              leftSection={<IconLayoutSidebarRight size={14} stroke={1.5} />}
              onClick={plan.onToggle}
            >
              Plan
            </Button>
          )}
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
