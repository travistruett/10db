import { TerminalApp, type ChatDto, type ConversationDto } from '@10db/contracts';
import { ActionIcon, Tooltip } from '@mantine/core';
import { IconTerminal2 } from '@tabler/icons-react';
import { useSessionsSettings } from '../../daemon/sessions-settings-queries';
import { useOpenTakeover, useTakeoverPreview } from '../../daemon/takeover-queries';
import { TerminalPopover } from './terminal-popover';

export interface TerminalButtonProps {
  readonly chat: ChatDto;
  readonly conversation: ConversationDto;
  /** The project's folder, named in the popover. */
  readonly path: string;
  readonly opened: boolean;
  readonly onOpened: (opened: boolean) => void;
}

/**
 * The session bar's Open in Terminal (sessions UI spec §10.1): its popover reads what would stop it when it
 * opens, and confirming opens the chat in the app Settings › Sessions names. With Copy the Command the
 * command goes to the clipboard, and the banner offers it again.
 */
export function TerminalButton({
  chat,
  conversation,
  path,
  opened,
  onOpened,
}: TerminalButtonProps) {
  const settings = useSessionsSettings();
  const preview = useTakeoverPreview(chat.conversationId, opened);
  const open = useOpenTakeover();
  const app = settings.data?.terminalApp ?? TerminalApp.Terminal;
  const close = (): void => {
    open.reset();
    onOpened(false);
  };
  return (
    <TerminalPopover
      opened={opened}
      onClose={close}
      app={app}
      label={conversation.capabilities.label}
      path={path}
      refusal={preview.data === undefined ? undefined : preview.data.refusal}
      notes={preview.data?.notes ?? []}
      pending={open.isPending}
      error={open.error?.message ?? (preview.isError ? preview.error.message : null)}
      onConfirm={() => {
        open.mutate(chat.conversationId, {
          onSuccess: (taken) => {
            // The banner offers the command again if the browser refuses the copy.
            if (taken.line !== null)
              void navigator.clipboard.writeText(taken.line).catch(() => undefined);
            close();
          },
        });
      }}
    >
      <Tooltip label="Open in Terminal">
        <ActionIcon
          variant="subtle"
          aria-label="Open in Terminal"
          aria-expanded={opened}
          onClick={() => {
            onOpened(!opened);
          }}
        >
          <IconTerminal2 size={16} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
    </TerminalPopover>
  );
}
