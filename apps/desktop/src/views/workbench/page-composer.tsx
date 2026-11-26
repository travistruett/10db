import type { ProjectId } from '@10db/contracts';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Composer } from '../../conversation/composer';
import { hasTyped, type Draft, type DraftChange } from '../../conversation/drafts';
import { dropPreviewPicks } from '../../desktop/preview';
import { PAGE_IMAGES } from './page-images';
import { PickChips } from './pick-chips';
import { picksMessage, withoutPick } from './pick-message';
import { pageComposerPhase, pagePhase } from './page-composer-phase';
import { focusIsPreviews } from './preview-focus';
import type { PageStatus } from './page-status';

/** What a page's composer asks the daemon to do; each rejects with the daemon's words. */
export interface PageActions {
  readonly send: (draft: Draft) => Promise<void>;
  /** A plain Stop: the turn ends and nothing is sent. */
  readonly stop: () => Promise<void>;
  /** Stops the turn and starts it again from the draft. */
  readonly redo: (draft: Draft) => Promise<void>;
}

export interface PageComposerProps {
  /** The page's name, for the placeholder and the input's name. */
  readonly label: string;
  readonly status: PageStatus;
  /** Nothing has been said to the page yet. */
  readonly firstMessage: boolean;
  /** The page's draft, kept by the workspace per page. */
  readonly draft: Draft;
  readonly onDraft: (change: DraftChange) => void;
  readonly actions: PageActions;
  /** The input, which the workspace focuses when a page is selected. */
  readonly inputRef?: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  /** Why Commit failed, drawn under the input. */
  readonly error?: string | null;
  /** Nothing can be sent or stopped: the pass is closing or abandoning. */
  readonly disabled?: boolean;
  /** The page's project, whose Preview its picks came from. */
  readonly projectId: ProjectId;
  /** The page's route, named over its picks. */
  readonly route: string | null;
  /** Counts the Preview bringing the window forward on this page: each time, its picks take the cursor. */
  readonly picksFocus?: number;
}

/**
 * A page's composer (Workbench spec §4.3, design review D14): the kit's composer with the pass's phase
 * table: Attach, Dictate and Send or Stop. Enter sends and Shift+Enter is a new line.
 */
export function PageComposer({
  label,
  status,
  firstMessage,
  draft,
  onDraft,
  actions,
  inputRef,
  error = null,
  disabled = false,
  projectId,
  route,
  picksFocus = 0,
}: PageComposerProps) {
  // The input empties as Send is pressed; until the message reaches the page the composer is drawn as
  // holding it, so Send stays the primary.
  const [sending, setSending] = useState(0);
  const picks = draft.picks ?? [];
  const { phase } = pageComposerPhase(pagePhase(status), {
    typed: hasTyped(draft) || sending > 0,
    picks: picks.length > 0,
    label,
    firstMessage,
  });
  const picksHead = useRef<HTMLDivElement>(null);
  // The Preview's ask: the picks take the cursor, or, with none yet, nothing in the composer holds it.
  // It runs on a page the ask selected too, which mounts a new composer; an ask long past moves nothing.
  useEffect(() => {
    if (picksFocus === 0 || !focusIsPreviews()) return;
    if (picksHead.current !== null) picksHead.current.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [picksFocus]);
  // A pick sent leaves the Preview too; one whose send failed comes back into the draft with its badge.
  const settle = async (sent: Draft, go: (message: Draft) => Promise<void>) => {
    await go(picksMessage(sent));
    void dropPreviewPicks(
      projectId,
      (sent.picks ?? []).map((p) => p.pick.id),
    );
  };
  return (
    <Composer
      draft={draft}
      onDraft={onDraft}
      capabilities={{ images: PAGE_IMAGES }}
      phase={phase}
      disabledReason={null}
      error={error}
      locked={disabled}
      pending={
        <PickChips
          projectId={projectId}
          route={route}
          picks={picks}
          headRef={picksHead}
          onRemove={(pickId) => {
            onDraft((now) => withoutPick(now, pickId));
          }}
        />
      }
      onSend={async (sent) => {
        setSending((n) => n + 1);
        try {
          await settle(sent, actions.send);
        } finally {
          setSending((n) => n - 1);
        }
      }}
      onStop={actions.stop}
      onRedo={(sent) => settle(sent, actions.redo)}
      label={`Message to ${label}`}
      attachLabel="Add Picture"
      {...(inputRef === undefined ? {} : { inputRef })}
    />
  );
}
