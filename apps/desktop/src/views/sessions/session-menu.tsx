import { Menu } from '@mantine/core';

/** What a session's menu does; an action left out leaves its item out. */
export interface SessionActions {
  readonly onRename?: () => void;
  /** File as Tasks: asks the agent to file what the conversation agreed on. */
  readonly onFileAsTasks?: () => void;
  /** The agent offers Open in Terminal and the session can go there now. */
  readonly onOpenInTerminal?: () => void;
  readonly onMakeTask?: () => void;
  readonly onArchive?: () => void;
  readonly onClose: () => void;
}

/** The items of a session's menu, in the panel's right-click menu and the title row's ⋯. */
export function SessionMenuItems({ actions }: { readonly actions: SessionActions }) {
  return (
    <>
      {actions.onRename === undefined ? null : (
        <Menu.Item onClick={actions.onRename}>Rename</Menu.Item>
      )}
      {actions.onFileAsTasks === undefined ? null : (
        <Menu.Item onClick={actions.onFileAsTasks}>File as Tasks</Menu.Item>
      )}
      {actions.onOpenInTerminal === undefined ? null : (
        <Menu.Item onClick={actions.onOpenInTerminal}>Open in Terminal</Menu.Item>
      )}
      {actions.onMakeTask === undefined ? null : (
        <Menu.Item onClick={actions.onMakeTask}>Make a Board Task…</Menu.Item>
      )}
      {actions.onArchive === undefined ? null : (
        <Menu.Item onClick={actions.onArchive}>Archive</Menu.Item>
      )}
      <Menu.Item onClick={actions.onClose}>Close</Menu.Item>
    </>
  );
}
