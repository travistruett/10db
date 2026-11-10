import { CloseStep, Delivery, PassState } from '@10db/contracts';
import { Group, Loader, Text, VisuallyHidden } from '@mantine/core';
import { useState } from 'react';

/** What decides which of a close's steps do anything (spec §5.4). */
export interface CloseFacts {
  /** A pull request project gates in a separate copy and pushes; a local one gates in the folder. */
  readonly delivery: Delivery;
  /** The project has a gate command. */
  readonly gated: boolean;
  /** Some page of the pass is not signed off, so the close takes it out. */
  readonly takingOut: boolean;
}

/** A step of the close after the confirm, what it says while it runs, and whether it does anything. */
const STEPS: readonly {
  readonly after: CloseStep;
  readonly line: string;
  readonly runs: (facts: CloseFacts) => boolean;
}[] = [
  { after: CloseStep.Confirmed, line: "Landing the close's changes…", runs: () => true },
  {
    after: CloseStep.Landed,
    line: 'Running the gate in a separate copy…',
    runs: (facts) => facts.gated && facts.delivery === Delivery.PullRequest,
  },
  { after: CloseStep.ScratchGated, line: 'Taking out pages…', runs: (facts) => facts.takingOut },
  {
    after: CloseStep.TakenOut,
    line: 'Running the gate in your folder…',
    runs: (facts) => facts.gated && facts.delivery === Delivery.Local,
  },
  {
    after: CloseStep.FolderGated,
    // A local project pushes only when it has an origin, which the view does not say.
    line: 'Pushing…',
    runs: (facts) => facts.delivery === Delivery.PullRequest,
  },
  { after: CloseStep.Pushed, line: "Moving your folder's branch…", runs: () => true },
  { after: CloseStep.FastForwarded, line: 'Closing the pass…', runs: () => true },
];

/** What a closing pass does next: the first step after the last finished that does anything. */
function closingLine(step: CloseStep | null, facts: CloseFacts): string {
  if (step === null) return 'Closing the pass…';
  const next = STEPS.find((candidate) => candidate.after >= step && candidate.runs(facts));
  // A local project after its folder gate: a push if it has an origin, then the folder's branch.
  if (
    facts.delivery === Delivery.Local &&
    step <= CloseStep.FolderGated &&
    next?.after === CloseStep.Pushed
  )
    return 'Finishing the close…';
  return next?.line ?? 'Closing the pass…';
}

/** What a pass that is ending is doing, in words; null while it is open or once it has ended. */
export function closeProgressLine(
  state: PassState,
  step: CloseStep | null,
  facts: CloseFacts,
): string | null {
  switch (state) {
    case PassState.Closing:
      return closingLine(step, facts);
    case PassState.Abandoning:
      return 'Abandoning the pass…';
    case PassState.Open:
    case PassState.Closed:
    case PassState.Settled:
    case PassState.Abandoned:
      return null;
  }
}

export interface CloseProgressProps {
  readonly state: PassState;
  /** The last close step that finished; null before the first. */
  readonly step: CloseStep | null;
  readonly facts: CloseFacts;
}

/**
 * The pass's close or abandon under way (Workbench spec §5.4), said under the header line as each
 * step goes. Only its first line is announced: a close has up to seven steps, and a live region that
 * spoke each would chatter.
 */
export function CloseProgress({ state, step, facts }: CloseProgressProps) {
  const line = closeProgressLine(state, step, facts);
  // The first line of this close or abandon, held until the pass is neither.
  const [announced, setAnnounced] = useState<string | null>(line);
  if (line === null && announced !== null) setAnnounced(null);
  if (line !== null && announced === null) setAnnounced(line);
  return (
    <>
      {/* Always present, so a screen reader hears the line that fills it. */}
      <VisuallyHidden role="status">{announced}</VisuallyHidden>
      {line === null ? null : (
        <Group gap="xs" wrap="nowrap">
          <Loader size="xs" />
          <Text size="sm">{line}</Text>
        </Group>
      )}
    </>
  );
}
