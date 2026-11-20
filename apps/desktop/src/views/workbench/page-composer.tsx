import type { ImageFormat } from '@10db/contracts';
import { useState, type RefObject } from 'react';
import { Composer } from '../../conversation/composer';
import { hasContent, type Draft, type DraftChange } from '../../conversation/drafts';
import { pageComposerPhase, pagePhase } from './page-composer-phase';
import type { PageStatus } from './page-status';

/** What a page's composer asks the daemon to do; each rejects with the daemon's words. */
export interface PageActions {
  readonly send: (draft: Draft) => Promise<void>;
  /** A plain Stop: the turn ends and nothing is sent. */
  readonly stop: () => Promise<void>;
  /** Stops the turn and starts it again from the draft. */
  readonly redo: (draft: Draft) => Promise<void>;
}

/** What a page takes: PNG, JPEG and WebP pictures, on every account (Workbench spec §4.3). */
const PAGE_IMAGES: ImageFormat[] = ['png', 'jpeg', 'webp'];

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
}: PageComposerProps) {
  // The input empties as Send is pressed; until the message reaches the page the composer is drawn as
  // holding it, so Send stays the primary.
  const [sending, setSending] = useState(0);
  const { phase } = pageComposerPhase(pagePhase(status), {
    hasContent: hasContent(draft) || sending > 0,
    label,
    firstMessage,
  });
  return (
    <Composer
      draft={draft}
      onDraft={onDraft}
      capabilities={{ images: PAGE_IMAGES }}
      phase={phase}
      disabledReason={null}
      error={error}
      locked={disabled}
      onSend={async (sent) => {
        setSending((n) => n + 1);
        try {
          await actions.send(sent);
        } finally {
          setSending((n) => n - 1);
        }
      }}
      onStop={actions.stop}
      onRedo={actions.redo}
      label={`Message to ${label}`}
      attachLabel="Add Picture"
      {...(inputRef === undefined ? {} : { inputRef })}
    />
  );
}
