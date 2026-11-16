import { Menu } from '@mantine/core';

/** What a tab's menu does; Archive is a chat's only. */
export interface TabActions {
  readonly onRename?: () => void;
  readonly onArchive?: () => void;
  /** A chat's: the agent offers Open in Terminal and the chat can go there now. */
  readonly onOpenInTerminal?: () => void;
  readonly onClose: () => void;
  readonly onCloseOthers: () => void;
  /** Close Other Tabs has nothing to close with one tab open. */
  readonly othersOpen: boolean;
}

/** The items of a tab's menu, in the strip's right-click menu and the session bar's ⋯. */
export function TabMenuItems({ actions }: { readonly actions: TabActions }) {
  return (
    <>
      {actions.onRename === undefined ? null : (
        <Menu.Item onClick={actions.onRename}>Rename</Menu.Item>
      )}
      {actions.onOpenInTerminal === undefined ? null : (
        <Menu.Item onClick={actions.onOpenInTerminal}>Open in Terminal</Menu.Item>
      )}
      {actions.onArchive === undefined ? null : (
        <Menu.Item onClick={actions.onArchive}>Archive</Menu.Item>
      )}
      <Menu.Item onClick={actions.onClose}>Close Tab</Menu.Item>
      <Menu.Item disabled={!actions.othersOpen} onClick={actions.onCloseOthers}>
        Close Other Tabs
      </Menu.Item>
    </>
  );
}
