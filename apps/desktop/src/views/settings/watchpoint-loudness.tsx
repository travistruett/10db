import { WatchpointLoudness } from '@10db/contracts';
import {
  Box,
  SegmentedControl,
  Tooltip,
  type MantineSize,
  type MantineSpacing,
} from '@mantine/core';
import { ProjectChoice } from './watchpoint-lists';

const LOUDNESS_LABEL: Readonly<Record<WatchpointLoudness, string>> = {
  [WatchpointLoudness.Show]: 'Show',
  [WatchpointLoudness.Ask]: 'Ask',
  [WatchpointLoudness.Hold]: 'Hold',
};

/** What Show, Ask and Hold do, in the words the pages' info button uses. */
export const LOUDNESS_WORDS =
  "Show puts the changes in the task's For You and the pull request; nothing waits on you. Ask also leaves one Inbox card per task, for you to look at. Hold holds the pull request until you answer Merge.";

/** Says what Show, Ask and Hold do when the pointer rests on a When It Matches control. */
function WithLoudnessWords({ children }: { readonly children: React.ReactNode }) {
  return (
    <Tooltip label={LOUDNESS_WORDS} multiline w={280} openDelay={400} withinPortal>
      <Box display="inline-block">{children}</Box>
    </Tooltip>
  );
}

function isLoudness(value: string): value is WatchpointLoudness {
  return Object.values<string>(WatchpointLoudness).includes(value);
}

/** When It Matches for a watchpoint in its own list: Show, Ask or Hold. */
export function LoudnessControl({
  value,
  onChange,
  ariaLabel,
  mt,
  size = 'xs',
  disabled = false,
}: {
  readonly value: WatchpointLoudness;
  readonly onChange: (value: WatchpointLoudness) => void;
  readonly ariaLabel: string;
  readonly mt?: MantineSpacing;
  readonly size?: MantineSize;
  /** While a save is on its way: a second change would be built from the list before it. */
  readonly disabled?: boolean;
}) {
  return (
    <WithLoudnessWords>
      <SegmentedControl
        size={size}
        disabled={disabled}
        {...(mt === undefined ? {} : { mt })}
        aria-label={ariaLabel}
        data={[
          { value: WatchpointLoudness.Show, label: LOUDNESS_LABEL[WatchpointLoudness.Show] },
          { value: WatchpointLoudness.Ask, label: LOUDNESS_LABEL[WatchpointLoudness.Ask] },
          { value: WatchpointLoudness.Hold, label: LOUDNESS_LABEL[WatchpointLoudness.Hold] },
        ]}
        value={value}
        onChange={(next) => {
          if (isLoudness(next)) onChange(next);
        }}
      />
    </WithLoudnessWords>
  );
}

function isProjectChoice(value: string): value is ProjectChoice {
  return Object.values<string>(ProjectChoice).includes(value);
}

/**
 * When It Matches for one of the builder's watchpoints in a project: Default follows All Projects and says
 * what that is now; Show and Ask set it here; Off turns it off here.
 */
export function ProjectChoiceControl({
  value,
  defaultLoudness,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  readonly value: ProjectChoice | WatchpointLoudness;
  readonly defaultLoudness: WatchpointLoudness;
  readonly onChange: (value: ProjectChoice) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
}) {
  return (
    <WithLoudnessWords>
      <SegmentedControl
        size="xs"
        disabled={disabled}
        aria-label={ariaLabel}
        data={[
          { value: ProjectChoice.Default, label: `Default · ${LOUDNESS_LABEL[defaultLoudness]}` },
          { value: ProjectChoice.Show, label: LOUDNESS_LABEL[WatchpointLoudness.Show] },
          { value: ProjectChoice.Ask, label: LOUDNESS_LABEL[WatchpointLoudness.Ask] },
          { value: ProjectChoice.Hold, label: LOUDNESS_LABEL[WatchpointLoudness.Hold] },
          { value: ProjectChoice.Off, label: 'Off' },
        ]}
        value={value}
        onChange={(next) => {
          if (isProjectChoice(next)) onChange(next);
        }}
      />
    </WithLoudnessWords>
  );
}
