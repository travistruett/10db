import { TerminalApp } from '@10db/contracts';
import { Button, Group, List, Popover, Stack, Text } from '@mantine/core';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

// Sessions UI spec §10.1: Open in Terminal warns every time, in one short popover anchored to its button.

const APP_NAMES: Readonly<Record<TerminalApp, string>> = {
  [TerminalApp.Terminal]: 'Terminal',
  [TerminalApp.ITerm]: 'iTerm',
  [TerminalApp.Copy]: 'your terminal',
};

export interface TerminalPopoverProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  /** The button the popover hangs from. */
  readonly children: ReactNode;
  readonly app: TerminalApp;
  /** The agent's name, `capabilities.label`. */
  readonly label: string;
  /** The project's folder. */
  readonly path: string;
  /** What the daemon says would stop it, or null; undefined while it is read. */
  readonly refusal: string | null | undefined;
  /** What the builder is told about this terminal, in the daemon's words. */
  readonly notes: readonly string[];
  readonly pending: boolean;
  /** The daemon's reason the last open failed. */
  readonly error: string | null;
  readonly onConfirm: () => void;
}

export function TerminalPopover({
  opened,
  onClose,
  children,
  app,
  label,
  path,
  refusal,
  notes,
  pending,
  error,
  onConfirm,
}: TerminalPopoverProps) {
  const copy = app === TerminalApp.Copy;
  const confirm = useRef<HTMLButtonElement>(null);
  // Enter confirms, so the warning costs one key: the button takes the focus once it can be pressed.
  const ready = refusal === null;
  useEffect(() => {
    if (opened && ready) confirm.current?.focus();
  }, [opened, ready]);
  return (
    <Popover
      opened={opened}
      onChange={(next) => {
        if (!next) onClose();
      }}
      position="bottom-end"
      width={360}
      withArrow
      withinPortal
      // The bar never scrolls away; jsdom has no layout, which would read as a detached target.
      hideDetached={false}
    >
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown aria-label="Open in Terminal">
        <Stack gap="xs">
          <Text fw={600} size="sm">
            Open in Terminal
          </Text>
          <Text size="sm">
            {copy
              ? `Gives you the command that continues this session with ${label}'s own resume, in ${path}, for zsh or bash. `
              : `Continues this session in ${APP_NAMES[app]} with ${label}'s own resume, in ${path}. `}
            It runs outside 10db&apos;s sandbox, with this session&apos;s instructions, plugins and
            MCP servers, and without your settings file. 10db won&apos;t touch this session until
            you hand it back.
          </Text>
          {notes.length === 0 ? null : (
            <List size="xs" c="dimmed" spacing={2} aria-label="What to know">
              {notes.map((note) => (
                <List.Item key={note}>{note}</List.Item>
              ))}
            </List>
          )}
          {refusal === null || refusal === undefined ? null : (
            <Text size="sm" role="status">
              {refusal}
            </Text>
          )}
          {error === null ? null : (
            <Text size="sm" c="red" role="alert">
              {error}
            </Text>
          )}
          <Group justify="flex-end" gap="xs">
            <Button size="xs" variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            <Button ref={confirm} size="xs" disabled={!ready} loading={pending} onClick={onConfirm}>
              {copy ? 'Copy the Command' : 'Open in Terminal'}
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
