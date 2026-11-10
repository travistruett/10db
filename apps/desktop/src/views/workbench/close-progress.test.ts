import { CloseStep, PassState } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { closeProgressLine } from './close-progress';

describe('closeProgressLine', () => {
  it.each<{ name: string; state: PassState; step: CloseStep | null; line: string | null }>([
    { name: 'open', state: PassState.Open, step: null, line: null },
    {
      name: 'closing, no step yet',
      state: PassState.Closing,
      step: null,
      line: 'Closing the pass…',
    },
    {
      name: 'confirmed',
      state: PassState.Closing,
      step: CloseStep.Confirmed,
      line: 'Signing off and landing…',
    },
    {
      name: 'landed',
      state: PassState.Closing,
      step: CloseStep.Landed,
      line: 'Running the gate…',
    },
    {
      name: 'scratch gate passed',
      state: PassState.Closing,
      step: CloseStep.ScratchGated,
      line: 'Taking out pages…',
    },
    {
      name: 'taken out',
      state: PassState.Closing,
      step: CloseStep.TakenOut,
      line: 'Running the gate in your folder…',
    },
    {
      name: 'folder gated',
      state: PassState.Closing,
      step: CloseStep.FolderGated,
      line: 'Pushing…',
    },
    {
      name: 'pushed',
      state: PassState.Closing,
      step: CloseStep.Pushed,
      line: "Moving your folder's branch…",
    },
    {
      name: 'fast-forwarded',
      state: PassState.Closing,
      step: CloseStep.FastForwarded,
      line: 'Closing the pass…',
    },
    { name: 'abandoning', state: PassState.Abandoning, step: null, line: 'Abandoning the pass…' },
    { name: 'closed', state: PassState.Closed, step: CloseStep.Closed, line: null },
  ])('$name', ({ state, step, line }) => {
    expect(closeProgressLine(state, step)).toBe(line);
  });
});
