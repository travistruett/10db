import { CloseStep, PassState } from '@10db/contracts';
import { Group, Loader, Text, VisuallyHidden } from '@mantine/core';
import { useState } from 'react';

/** What a closing pass does next, by the last close step that finished (spec §5.4). */
function closingLine(step: CloseStep | null): string {
  switch (step) {
    case null:
    case CloseStep.FastForwarded:
    case CloseStep.Closed:
      return 'Closing the pass…';
    case CloseStep.Confirmed:
      return 'Signing off and landing…';
    case CloseStep.Landed:
      return 'Running the gate…';
    case CloseStep.ScratchGated:
      return 'Taking out pages…';
    case CloseStep.TakenOut:
      return 'Running the gate in your folder…';
    case CloseStep.FolderGated:
      return 'Pushing…';
    case CloseStep.Pushed:
      return "Moving your folder's branch…";
  }
}

/** What a pass that is ending is doing, in words; null while it is open or once it has ended. */
export function closeProgressLine(state: PassState, step: CloseStep | null): string | null {
  switch (state) {
    case PassState.Closing:
      return closingLine(step);
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
}

/**
 * The pass's close or abandon under way (Workbench spec §5.4), said under the header line as each
 * step goes. Only its first line is announced: a close has up to seven steps, and a live region that
 * spoke each would chatter.
 */
export function CloseProgress({ state, step }: CloseProgressProps) {
  const line = closeProgressLine(state, step);
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
