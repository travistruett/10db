import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { dropPreviewPicks, listenToPreviews, previewAvailable } from '../../desktop/preview';
import { bringWindowForward } from '../../desktop/tauri';
import { draftKey, sessionDrafts } from '../sessions/session-drafts';
import { withArrivedPick, withoutPick } from './pick-message';
import { askPicksFocus } from './preview-focus';

/**
 * Pick on Page spec §4, §5: what the Previews hand the main window, for as long as the window is open,
 * whichever view shows. A pick only ever lands in its page's draft as a chip, or is refused there; the
 * Preview's "N in <page> ›" selects that page and brings the window forward on its picks.
 */
export function usePreviewPicks(): void {
  const navigate = useNavigate();
  const go = useRef(navigate);
  useEffect(() => {
    go.current = navigate;
  });
  useEffect(() => {
    if (!previewAvailable()) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void listenToPreviews({
      picked: (arrived) => {
        const key = draftKey.task(arrived.taskId);
        const { draft, refused } = withArrivedPick(sessionDrafts.get(key), arrived);
        if (refused !== null) {
          void dropPreviewPicks(arrived.projectId, [arrived.pick.id], refused);
          return;
        }
        sessionDrafts.set(key, draft);
      },
      removed: ({ taskId, pickId }) => {
        const key = draftKey.task(taskId);
        sessionDrafts.set(key, withoutPick(sessionDrafts.get(key), pickId));
      },
      showComposer: ({ taskId }) => {
        // The window comes back to what it last focused, often the composer's input: let go of it first.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        askPicksFocus(taskId);
        void go.current({ to: '/workbench', search: { task: taskId } });
        void bringWindowForward();
      },
    }).then((off) => {
      if (gone) off();
      else stop = off;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
}
