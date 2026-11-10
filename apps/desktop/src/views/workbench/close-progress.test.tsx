import { CloseStep, PassState } from '@10db/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderWithTheme } from '../../test/theme';
import { CloseProgress, closeProgressLine } from './close-progress';

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

/** The progress of a close that has landed, with a button that moves it on to after the folder gate. */
function Closing() {
  const [step, setStep] = useState<CloseStep>(CloseStep.Landed);
  return (
    <>
      <CloseProgress state={PassState.Closing} step={step} />
      <button
        type="button"
        onClick={() => {
          setStep(CloseStep.FolderGated);
        }}
      >
        Next step
      </button>
    </>
  );
}

describe('CloseProgress', () => {
  it('announces the close once, while its line follows each step', () => {
    renderWithTheme(<Closing />);
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getAllByRole('status').map((status) => status.textContent)).toEqual([
      'Running the gate…',
    ]);
    expect(screen.getByText('Pushing…')).toBeTruthy();
  });
});
