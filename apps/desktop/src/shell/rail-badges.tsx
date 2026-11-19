import type { ProjectId } from '@10db/contracts';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useOpenInboxCount } from '../views/inbox/inbox-count';
import { useSessionsNeedingYou } from '../views/sessions/needing-you-count';
import { nextNeeding } from '../views/sessions/session-keys';
import { useWorkbenchWaitingCount } from '../views/workbench/workbench-count';
import { CountBadge, CountTone } from './count-badge';
import { useRailMode } from './rail-mode';

/** A rail badge is small, so a count past this reads "99+". */
const BADGE_CAP = 99;

/** The open Inbox cards, across every project; nothing when none is open. */
export function InboxBadge() {
  const count = useOpenInboxCount();
  const compact = !useRailMode().labels;
  if (count === 0) return null;
  return (
    <CountBadge
      count={count}
      tone={CountTone.Attention}
      cap={BADGE_CAP}
      compact={compact}
      phrase={`${String(count)} open card${count === 1 ? '' : 's'}`}
    />
  );
}

/**
 * The sessions waiting on the builder; nothing when none does. A click goes to the next one after the
 * open tab, from any view (UI spec §5.5); the link around it would only open Sessions.
 */
export function SessionsBadge() {
  const needing = useSessionsNeedingYou();
  const compact = !useRailMode().labels;
  const navigate = useNavigate();
  const current = useRouterState({
    select: (state) => {
      const chat: unknown = state.location.search.chat;
      return typeof chat === 'string' ? chat : null;
    },
  });
  const count = needing.length;
  if (count === 0) return null;
  const goNext = (): void => {
    const at = needing.findIndex((chat) => chat.id === current);
    const next =
      needing[
        nextNeeding(
          needing.map(() => true),
          at,
        ) ?? 0
      ];
    if (next === undefined) return;
    void navigate({ to: '/sessions', search: { chat: next.id } });
  };
  return (
    // Keyboard users have ⌘J for the same move, so the badge is a pointer shortcut only.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <span
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        goNext();
      }}
    >
      <CountBadge
        count={count}
        tone={CountTone.Attention}
        cap={BADGE_CAP}
        compact={compact}
        phrase={`${String(count)} session${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you`}
      />
    </span>
  );
}

/** The pages of the project's pass that wait on the builder; nothing when none does. */
export function WorkbenchBadge({ projectId }: { readonly projectId: ProjectId }) {
  const count = useWorkbenchWaitingCount(projectId);
  const compact = !useRailMode().labels;
  if (count === 0) return null;
  return (
    <CountBadge
      count={count}
      tone={CountTone.Attention}
      cap={BADGE_CAP}
      compact={compact}
      phrase={`${String(count)} page${count === 1 ? '' : 's'} waiting`}
    />
  );
}
