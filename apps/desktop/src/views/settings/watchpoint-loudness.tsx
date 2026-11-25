import { WatchpointLoudness } from '@10db/contracts';
import { SegmentedControl, Tooltip, type MantineSpacing } from '@mantine/core';

/** Which loudness the app can act on so far: Ask and Hold are shown but not offered. */
const WHY_OFF: Readonly<Partial<Record<WatchpointLoudness, string>>> = {
  [WatchpointLoudness.Ask]: 'Next',
  [WatchpointLoudness.Hold]: 'Coming later',
};

/** Show, Ask and Hold as one control; only Show can be chosen yet, and the others say when they come. */
export function LoudnessControl({
  value,
  onChange,
  ariaLabel,
  mt,
}: {
  readonly value: WatchpointLoudness;
  readonly onChange: (value: WatchpointLoudness) => void;
  readonly ariaLabel: string;
  readonly mt?: MantineSpacing;
}) {
  const item = (loudness: WatchpointLoudness, label: string) => {
    const why = WHY_OFF[loudness];
    return {
      value: loudness,
      disabled: why !== undefined,
      label:
        why === undefined ? (
          label
        ) : (
          <Tooltip label={why}>
            <span>{label}</span>
          </Tooltip>
        ),
    };
  };
  return (
    <SegmentedControl
      size="xs"
      {...(mt === undefined ? {} : { mt })}
      aria-label={ariaLabel}
      data={[
        item(WatchpointLoudness.Show, 'Show'),
        item(WatchpointLoudness.Ask, 'Ask'),
        item(WatchpointLoudness.Hold, 'Hold'),
      ]}
      value={value}
      onChange={(next) => {
        if (next === WatchpointLoudness.Show) onChange(WatchpointLoudness.Show);
      }}
    />
  );
}
