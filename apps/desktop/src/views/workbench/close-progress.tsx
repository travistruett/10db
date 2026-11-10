import { CloseStep, PassState } from '@10db/contracts';
import { Group, Loader, Text } from '@mantine/core';

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

/** The pass's close or abandon under way (Workbench spec §5.4), said once under the header line. */
export function CloseProgress({ state, step }: CloseProgressProps) {
  const line = closeProgressLine(state, step);
  if (line === null) return null;
  return (
    <Group gap="xs" role="status" wrap="nowrap">
      <Loader size="xs" />
      <Text size="sm">{line}</Text>
    </Group>
  );
}
