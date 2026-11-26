import { WatchpointLoudness } from '@10db/contracts';
import { SegmentedControl, Tooltip, type MantineSize, type MantineSpacing } from '@mantine/core';

/** Which loudness the app can act on so far: Hold is shown but not offered. */
const WHY_OFF: Readonly<Partial<Record<WatchpointLoudness, string>>> = {
  [WatchpointLoudness.Hold]: 'Coming later',
};

/** Show, Ask and Hold as one control; Hold can't be chosen yet and says when it comes. */
export function LoudnessControl({
  value,
  onChange,
  ariaLabel,
  mt,
  size = 'xs',
}: {
  readonly value: WatchpointLoudness;
  readonly onChange: (value: WatchpointLoudness) => void;
  readonly ariaLabel: string;
  readonly mt?: MantineSpacing;
  readonly size?: MantineSize;
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
      size={size}
      {...(mt === undefined ? {} : { mt })}
      aria-label={ariaLabel}
      data={[
        item(WatchpointLoudness.Show, 'Show'),
        item(WatchpointLoudness.Ask, 'Ask'),
        item(WatchpointLoudness.Hold, 'Hold'),
      ]}
      value={value}
      onChange={(next) => {
        if (next === WatchpointLoudness.Show || next === WatchpointLoudness.Ask) onChange(next);
      }}
    />
  );
}
