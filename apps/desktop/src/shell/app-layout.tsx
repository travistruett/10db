import { Outlet, useNavigate } from '@tanstack/react-router';
import { useNewSessionKey } from './use-new-session-key';
import { useDaemonStatus } from '../daemon/provider';
import { useDesktopSync } from '../desktop/sync';
import { useRenderMode } from '../screens/render-context';
import { RenderLayout } from '../screens/render-layout';
import { ScreenRenderHost } from '../screens/screen-render-host';
import { FirstRun } from '../views/first-run/first-run';
import { usePreviewPicks } from '../views/workbench/use-preview-picks';
import { AppFrame } from './app-frame';
import { useSelectedProject } from './selected-project';

/** The shell, or in a frame the window draws a screen in (Shape spec §5.5), the screen alone. */
export function AppLayout() {
  return useRenderMode() === null ? <FullLayout /> : <RenderLayout />;
}

function FullLayout() {
  useDesktopSync();
  useNewSessionKey();
  usePreviewPicks();
  const status = useDaemonStatus();
  const { projects, select } = useSelectedProject();
  const navigate = useNavigate();
  // The first run replaces the shell only once the list has loaded empty on a live connection; while
  // it loads, or the daemon connects or reconnects, the shell shows (the title row's pill says it is reconnecting).
  if (status.kind === 'connected' && projects.isSuccess && projects.data.length === 0) {
    return (
      <FirstRun
        onCreated={(project) => {
          select(project.id);
          void navigate({ to: '/board' });
        }}
      />
    );
  }
  return (
    // Nothing goes above a view: what needs the builder is a card in the Inbox.
    <AppFrame>
      {status.kind === 'connected' && <ScreenRenderHost />}
      <Outlet />
    </AppFrame>
  );
}
