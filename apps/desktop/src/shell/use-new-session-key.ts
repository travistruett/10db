import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useOpenChats } from '../daemon/chat-queries';
import { openFreshTab, readFreshTabs, writeFreshTabs } from '../views/sessions/fresh-tabs';
import { sessionKey } from '../views/sessions/session-keys';
import { useSelectedProject } from './selected-project';

/**
 * ⌘T (New Session) and ⌘⇧N (New Plan) from any view other than Sessions open Sessions on a fresh tab at the
 * end of the strip, in the selected project. On Sessions the screen's own keys take them, beside the tab that is open.
 */
export function useNewSessionKey(): void {
  const navigate = useNavigate();
  const { projects, project } = useSelectedProject();
  const open = useOpenChats();
  const onSessions = useRouterState({
    select: (state) =>
      state.location.pathname === '/sessions' || state.location.pathname.startsWith('/sessions/'),
  });
  const latest = useRef({ onSessions, projects: projects.data ?? [], project, chats: open.data });
  useEffect(() => {
    latest.current = { onSessions, projects: projects.data ?? [], project, chats: open.data };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const now = latest.current;
      const key = sessionKey(
        {
          key: event.key,
          meta: event.metaKey,
          shift: event.shiftKey,
          ctrl: event.ctrlKey,
          alt: event.altKey,
        },
        { onSessions: now.onSessions, escapeTaken: false },
      );
      if ((key?.kind !== 'new' && key?.kind !== 'new_plan') || now.onSessions) return;
      event.preventDefault();
      const fresh = readFreshTabs();
      const made = openFreshTab(
        fresh,
        now.projects,
        now.project?.id ?? null,
        (now.chats?.length ?? 0) + fresh.length - 1,
        undefined,
        key.kind === 'new_plan',
      );
      if (made === null) return;
      writeFreshTabs(made.tabs);
      void navigate({ to: '/sessions', search: { fresh: made.opened.id } });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [navigate]);
}
