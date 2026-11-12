import { PassPreview, ScreenKind } from '@10db/contracts';
import { ShotOutcome } from './camera';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §8.2: who broke the preview,
// read from the page load that takes a task's picture. Blame is pass-wide: a turn breaks the preview
// only when the pass's last judged load was clean, and a load that may show half a turn counts for
// nothing. Before and after loads set the preview and blame nobody.

/** One load of a task's page route, as the picture took it. */
export interface PreviewLoad {
  readonly kind: ScreenKind;
  readonly outcome: ShotOutcome;
  /** The task is working again, or another task of the pass holds a shared area now. */
  readonly halfWritten: boolean;
}

/** What the rule reads of the pass and the task. */
export interface PreviewState {
  /** How the pass's last judged load went; null before any. */
  readonly preview: PassPreview | null;
  /** The task's open mark, with how many turns running its preview stayed broken. */
  readonly mark: { readonly turns: number } | null;
  /** Whether another page the pass holds has an open mark. */
  readonly otherMarks: boolean;
  /** Whether the header says the preview is broken with no turn named. */
  readonly unnamed: boolean;
}

/** What the load does to the task's mark. */
export type MarkStep = 'none' | 'open' | 'count' | 'mend';

export interface PreviewStep {
  /** The pass's preview after the load. */
  readonly preview: PassPreview | null;
  readonly mark: MarkStep;
  /** The task broke the preview on two turns running or more: offer it a separate copy. */
  readonly offerMove: boolean;
  /** The header's notice that the preview is broken with no turn named. */
  readonly unnamed: 'set' | 'clear' | 'keep';
}

const keep = (preview: PassPreview | null): PreviewStep => ({
  preview,
  mark: 'none',
  offerMove: false,
  unnamed: 'keep',
});

/** The preview after a clean load: clean once no page the pass holds is marked. */
function cleanStep(state: PreviewState, mark: MarkStep, marksLeft: boolean): PreviewStep {
  return marksLeft
    ? { preview: state.preview, mark, offerMove: false, unnamed: 'keep' }
    : { preview: PassPreview.Clean, mark, offerMove: false, unnamed: 'clear' };
}

/** What one load of a task's page route does to the pass's preview, the task's mark and the header. */
export function previewStep(state: PreviewState, load: PreviewLoad): PreviewStep {
  // Nothing answering means the app's dev server is not running: no page broke it.
  if (
    load.halfWritten ||
    load.outcome === ShotOutcome.Elsewhere ||
    load.outcome === ShotOutcome.NoAnswer
  )
    return keep(state.preview);
  const broken = load.outcome === ShotOutcome.Overlay || load.outcome === ShotOutcome.Failed;
  if (load.kind !== ScreenKind.Turn) {
    if (broken) return keep(PassPreview.Broken);
    return state.mark === null && !state.otherMarks
      ? cleanStep(state, 'none', false)
      : keep(state.preview);
  }
  if (!broken)
    return state.mark === null
      ? cleanStep(state, 'none', state.otherMarks)
      : cleanStep(state, 'mend', state.otherMarks);
  if (state.mark !== null)
    return {
      preview: PassPreview.Broken,
      mark: 'count',
      offerMove: state.mark.turns + 1 >= 2,
      unnamed: 'keep',
    };
  if (state.preview === PassPreview.Clean)
    return { preview: PassPreview.Broken, mark: 'open', offerMove: false, unnamed: 'keep' };
  if (state.otherMarks) return keep(PassPreview.Broken);
  return {
    preview: PassPreview.Broken,
    mark: 'none',
    offerMove: false,
    unnamed: state.unnamed ? 'keep' : 'set',
  };
}
