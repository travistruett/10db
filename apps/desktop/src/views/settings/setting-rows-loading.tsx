import { Box, Divider, Group, Paper, Skeleton, Stack } from '@mantine/core';
import { SKELETON_ON_PANEL, useLoadingDelayElapsed } from '../../shell/page-loading';
import { SETTING_CONTROL_WIDTH, SETTING_TEXT_MIN_WIDTH, SettingsCardHeading } from './setting-row';

/**
 * What a card of `SettingRow`s shows while its values load: the same bordered card, the same padding and
 * the same text and control columns, after the shell's delay.
 */
export function SettingRowsLoading({
  title,
  description,
  rows,
  label,
}: {
  /** The card's own title and line, which the loaded card draws too. */
  readonly title: string;
  readonly description?: string;
  readonly rows: number;
  /** What assistive tech hears, such as "Loading the timers". */
  readonly label: string;
}) {
  const late = useLoadingDelayElapsed();
  if (!late) return null;
  return (
    <Stack gap="xs" role="status" aria-label={label}>
      <SettingsCardHeading title={title} {...(description === undefined ? {} : { description })} />
      <Paper withBorder radius="md" className={SKELETON_ON_PANEL}>
        {Array.from({ length: rows }, (_, i) => (
          <Box key={i}>
            {i > 0 ? <Divider /> : null}
            <Box px="md" py="sm">
              <Group justify="space-between" wrap="nowrap" gap="xl">
                <Stack gap={6} miw={SETTING_TEXT_MIN_WIDTH} style={{ flex: 1 }}>
                  <Skeleton height={14} width="35%" />
                  <Skeleton height={12} width="65%" />
                </Stack>
                <Skeleton
                  height={36}
                  width={SETTING_CONTROL_WIDTH}
                  radius="sm"
                  style={{ flex: 'none' }}
                />
              </Group>
            </Box>
          </Box>
        ))}
      </Paper>
    </Stack>
  );
}
