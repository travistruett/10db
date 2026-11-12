import { CloseStep, PassState } from '@10db/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderWithTheme } from '../../test/theme';
import { CloseProgress, closeProgressLine, type CloseFacts } from './close-progress';

/** What the close does on a pull request project with a gate, taking a page out. */
const PR: CloseFacts = { delivery: 'pull_request', gated: true, takingOut: true, stopped: false };
/** A folder-only project: its gate runs in the folder, and nothing is pushed by the close's own step. */
const LOCAL: CloseFacts = { delivery: 'local', gated: true, takingOut: true, stopped: false };

describe('closeProgressLine', () => {
  it.each<{
    name: string;
    state: PassState;
    step: CloseStep | null;
    facts?: CloseFacts;
    line: string | null;
  }>([
    { name: 'open', state: PassState.Open, step: null, line: null },
    {
      name: 'closing, no step yet',
      state: PassState.Closing,
      step: null,
      line: 'Finishing…',
    },
    {
      name: 'confirmed',
      state: PassState.Closing,
      step: CloseStep.Confirmed,
      line: 'Landing the changes…',
    },
    {
      name: 'landed, gate in a copy',
      state: PassState.Closing,
      step: CloseStep.Landed,
      line: 'Running the gate in a separate copy…',
    },
    {
      name: 'copy gated',
      state: PassState.Closing,
      step: CloseStep.ScratchGated,
      line: 'Removing pages…',
    },
    {
      name: 'taken out, pushes next',
      state: PassState.Closing,
      step: CloseStep.TakenOut,
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
      line: 'Finishing…',
    },
    {
      name: 'folder-only, landed: no gate in a copy, so take-outs next',
      state: PassState.Closing,
      step: CloseStep.Landed,
      facts: LOCAL,
      line: 'Removing pages…',
    },
    {
      name: 'folder-only, taken out: the gate runs in the folder',
      state: PassState.Closing,
      step: CloseStep.TakenOut,
      facts: LOCAL,
      line: 'Running the gate in your folder…',
    },
    {
      name: 'folder-only, folder gated: a push only if it has an origin',
      state: PassState.Closing,
      step: CloseStep.FolderGated,
      facts: LOCAL,
      line: 'Finishing the close…',
    },
    {
      name: 'nothing to take out and no gate: the push is next',
      state: PassState.Closing,
      step: CloseStep.Landed,
      facts: { delivery: 'pull_request', gated: false, takingOut: false, stopped: false },
      line: 'Pushing…',
    },
    {
      name: 'closing, stopped on an error: nothing is under way until it goes on',
      state: PassState.Closing,
      step: CloseStep.ScratchGated,
      facts: { ...PR, stopped: true },
      line: null,
    },
    { name: 'abandoning', state: PassState.Abandoning, step: null, line: 'Abandoning…' },
    { name: 'closed', state: PassState.Closed, step: CloseStep.Closed, line: null },
  ])('$name', ({ state, step, facts = PR, line }) => {
    expect(closeProgressLine(state, step, facts)).toBe(line);
  });
});

/** The progress of a close that has landed, with a button that moves it on to after the folder gate. */
function Closing() {
  const [step, setStep] = useState<CloseStep>(CloseStep.Landed);
  return (
    <>
      <CloseProgress state={PassState.Closing} step={step} facts={PR} />
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
      'Running the gate in a separate copy…',
    ]);
    expect(screen.getByText('Pushing…')).toBeTruthy();
  });
});

/** A close at its take-out, with a button that removes the last unfinished page from the pass. */
function TakingOut() {
  const [takingOut, setTakingOut] = useState(true);
  return (
    <>
      <CloseProgress
        state={PassState.Closing}
        step={CloseStep.ScratchGated}
        facts={{ ...PR, takingOut }}
      />
      <button
        type="button"
        onClick={() => {
          setTakingOut(false);
        }}
      >
        Take out the last page
      </button>
    </>
  );
}

describe('CloseProgress while pages leave', () => {
  it('still says it takes pages out once the last leaves, before the step is recorded', () => {
    renderWithTheme(<TakingOut />);
    const line = (): string | null =>
      screen.getByText(/…$/, { ignore: '[role="status"]' }).textContent;
    expect(line()).toBe('Removing pages…');
    fireEvent.click(screen.getByRole('button', { name: 'Take out the last page' }));
    expect(line()).toBe('Removing pages…');
  });
});
