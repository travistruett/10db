import { PassPreview, ScreenKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { ShotOutcome } from './camera';
import { previewStep, type PreviewLoad, type PreviewState, type PreviewStep } from './preview-rule';

// Workbench spec §8.2, plan §3.3: who broke the preview, read from the load that takes a page's
// picture. Blame is pass-wide: a turn breaks the preview only when the pass's last load was clean.

const { Clean, Broken } = PassPreview;
const turn = (outcome: ShotOutcome, halfWritten = false): PreviewLoad => ({
  kind: ScreenKind.Turn,
  outcome,
  halfWritten,
});
const state = (over: Partial<PreviewState> = {}): PreviewState => ({
  preview: Clean,
  mark: null,
  otherMarks: false,
  unnamed: false,
  ...over,
});
const nothing = (preview: PassPreview | null): PreviewStep => ({
  preview,
  mark: 'none',
  offerMove: false,
  unnamed: 'keep',
});

describe('previewStep', () => {
  it.each<{ name: string; state: PreviewState; load: PreviewLoad; step: PreviewStep }>([
    {
      name: 'a load while the page works again is ignored: it may be half written',
      state: state({ mark: { turns: 1 }, preview: Broken }),
      load: turn(ShotOutcome.Clean, true),
      step: nothing(Broken),
    },
    {
      name: 'a broken load while another page holds a shared area is ignored',
      state: state(),
      load: turn(ShotOutcome.Overlay, true),
      step: nothing(Clean),
    },
    {
      name: 'a load that lands elsewhere is ignored',
      state: state(),
      load: turn(ShotOutcome.Elsewhere),
      step: nothing(Clean),
    },
    {
      name: "a turn's overlay after a clean load marks the page",
      state: state(),
      load: turn(ShotOutcome.Overlay),
      step: { preview: Broken, mark: 'open', offerMove: false, unnamed: 'keep' },
    },
    {
      name: "a turn's failed document after a clean load marks the page",
      state: state(),
      load: turn(ShotOutcome.Failed),
      step: { preview: Broken, mark: 'open', offerMove: false, unnamed: 'keep' },
    },
    {
      name: 'a broken turn when the pass was already broken names no turn: the header says so',
      state: state({ preview: Broken }),
      load: turn(ShotOutcome.Overlay),
      step: { preview: Broken, mark: 'none', offerMove: false, unnamed: 'set' },
    },
    {
      name: "a broken turn while another page's mark is open adds nothing: that page is named",
      state: state({ preview: Broken, otherMarks: true }),
      load: turn(ShotOutcome.Overlay),
      step: nothing(Broken),
    },
    {
      name: 'a broken turn before any judged load names no turn either',
      state: state({ preview: null }),
      load: turn(ShotOutcome.Failed),
      step: { preview: Broken, mark: 'none', offerMove: false, unnamed: 'set' },
    },
    {
      name: 'the header says it once',
      state: state({ preview: Broken, unnamed: true }),
      load: turn(ShotOutcome.Overlay),
      step: { preview: Broken, mark: 'none', offerMove: false, unnamed: 'keep' },
    },
    {
      name: "the marked page's next broken turn counts, and two running offer a separate copy",
      state: state({ preview: Broken, mark: { turns: 1 } }),
      load: turn(ShotOutcome.Overlay),
      step: { preview: Broken, mark: 'count', offerMove: true, unnamed: 'keep' },
    },
    {
      name: 'a third broken turn running still counts',
      state: state({ preview: Broken, mark: { turns: 2 } }),
      load: turn(ShotOutcome.Failed),
      step: { preview: Broken, mark: 'count', offerMove: true, unnamed: 'keep' },
    },
    {
      name: "the marked page's clean turn mends it, and the preview is clean again",
      state: state({ preview: Broken, mark: { turns: 2 } }),
      load: turn(ShotOutcome.Clean),
      step: { preview: Clean, mark: 'mend', offerMove: false, unnamed: 'clear' },
    },
    {
      name: 'a mended page leaves the preview broken while another page is marked',
      state: state({ preview: Broken, mark: { turns: 1 }, otherMarks: true }),
      load: turn(ShotOutcome.Clean),
      step: { preview: Broken, mark: 'mend', offerMove: false, unnamed: 'keep' },
    },
    {
      name: 'an unmarked clean turn makes the preview clean and clears the header',
      state: state({ preview: Broken, unnamed: true }),
      load: turn(ShotOutcome.Clean),
      step: { preview: Clean, mark: 'none', offerMove: false, unnamed: 'clear' },
    },
    {
      name: 'an unmarked clean turn leaves it broken while another page is marked',
      state: state({ preview: Broken, otherMarks: true }),
      load: turn(ShotOutcome.Clean),
      step: { preview: Broken, mark: 'none', offerMove: false, unnamed: 'keep' },
    },
    {
      name: 'a broken before sets the preview and blames nobody',
      state: state({ preview: null }),
      load: { kind: ScreenKind.Before, outcome: ShotOutcome.Overlay, halfWritten: false },
      step: { preview: Broken, mark: 'none', offerMove: false, unnamed: 'keep' },
    },
    {
      name: 'a clean before sets the preview clean',
      state: state({ preview: null }),
      load: { kind: ScreenKind.Before, outcome: ShotOutcome.Clean, halfWritten: false },
      step: { preview: Clean, mark: 'none', offerMove: false, unnamed: 'clear' },
    },
    {
      name: "a clean after mends no page's mark",
      state: state({ preview: Broken, mark: { turns: 1 } }),
      load: { kind: ScreenKind.After, outcome: ShotOutcome.Clean, halfWritten: false },
      step: nothing(Broken),
    },
  ])('$name', ({ state: s, load, step }) => {
    expect(previewStep(s, load)).toEqual(step);
  });
});
