import { Menu } from '@mantine/core';

/** What a session's menu does; an action left out leaves its item out. */
export interface SessionActions {
  readonly onRename?: () => void;
  /** Opens or closes the Plan panel; the item reads "Close Plan" while `planOpen`, else "Show Plan". */
  readonly onTogglePlan?: () => void;
  readonly planOpen?: boolean;
  /** The agent offers Open in Terminal and the session can go there now. */
  readonly onOpenInTerminal?: () => void;
  readonly onMakeTask?: () => void;
  /** Turns Full access on or off; the item reads "Turn Off Full Access" while `fullAccess`. */
  readonly onToggleFullAccess?: () => void;
  readonly fullAccess?: boolean;
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
      {actions.onTogglePlan === undefined ? null : (
        <Menu.Item onClick={actions.onTogglePlan}>
          {actions.planOpen === true ? 'Close Plan' : 'Show Plan'}
        </Menu.Item>
      )}
      {actions.onOpenInTerminal === undefined ? null : (
        <Menu.Item onClick={actions.onOpenInTerminal}>Open in Terminal</Menu.Item>
      )}
      {actions.onMakeTask === undefined ? null : (
        <Menu.Item onClick={actions.onMakeTask}>Make a Board Task…</Menu.Item>
      )}
      {actions.onToggleFullAccess === undefined ? null : (
        <Menu.Item onClick={actions.onToggleFullAccess}>
          {actions.fullAccess === true ? 'Turn Off Full Access' : 'Turn On Full Access…'}
        </Menu.Item>
      )}
      {actions.onArchive === undefined ? null : (
        <Menu.Item onClick={actions.onArchive}>Archive</Menu.Item>
      )}
      <Menu.Item onClick={actions.onClose}>Close</Menu.Item>
    </>
  );
}
