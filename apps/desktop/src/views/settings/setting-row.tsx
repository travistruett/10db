import { Box, Divider, Group, Paper, Stack, Text } from '@mantine/core';
import { Children, Fragment, useEffect, useId, useRef, type ReactNode } from 'react';
import { HelpHint } from './help-hint';
import { SectionHeading } from './section-heading';

/** A settings card's heading: its title, an optional info button and one dimmed line, and the card's action. */
export function SettingsCardHeading({
  title,
  description,
  help,
  action,
}: {
  readonly title: string;
  readonly description?: string;
  readonly help?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <SectionHeading
      title={title}
      {...(description === undefined || description === '' ? {} : { line: description })}
      {...(help ? { help } : {})}
      {...(action === undefined ? {} : { action })}
    />
  );
}

/** A titled card of settings rows, with a hairline between rows. */
export function SettingsCard({
  title,
  description,
  help,
  action,
  children,
}: {
  readonly title?: string;
  /** One short dimmed line under the title. */
  readonly description?: string;
  /** The long version of the title's note, behind an info button beside the title. */
  readonly help?: ReactNode;
  /** The section's one action, at the title's right. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  // Rows hidden by a condition render as null; Children.toArray drops them, so no divider doubles up.
  const rows = Children.toArray(children);
  return (
    <Stack gap="xs">
      {title ? (
        <SettingsCardHeading
          title={title}
          {...(description === undefined ? {} : { description })}
          help={help}
          action={action}
        />
      ) : null}
      <Paper withBorder radius="md">
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 ? <Divider /> : null}
            {row}
          </Fragment>
        ))}
      </Paper>
    </Stack>
  );
}

export interface SettingRowProps {
  readonly label: string;
  /** One line on what the setting does, in the builder's words. */
  readonly description?: ReactNode;
  /** The long version of the description, behind an info button beside the label. */
  readonly help?: ReactNode;
  /** The control; it carries the label for assistive tech (`aria-label`). */
  readonly children: ReactNode;
  /** A control too wide for the right column, such as a list, goes under the text instead. */
  readonly stacked?: boolean;
  /** What belongs to the row, shown under its text and control across the full width. */
  readonly below?: ReactNode;
}

/** The control a row's description belongs to: its input, or the group of radios. */
const CONTROL = 'textarea, input:not([type="hidden"]), [role="radiogroup"]';

/** The least width of a row's text column. */
export const SETTING_TEXT_MIN_WIDTH = 240;

/** The width of a row's control column. */
export const SETTING_CONTROL_WIDTH = 320;

/** How far a row's control column gives way in a narrow window. */
export const SETTING_CONTROL_MIN_WIDTH = 240;

/** One setting: its name and one line on the left, its control on the right. */
export function SettingRow({
  label,
  description,
  help,
  children,
  stacked = false,
  below,
}: SettingRowProps) {
  const descriptionId = useId();
  const row = useRef<HTMLDivElement>(null);
  // Mantine's inputs overwrite an `aria-describedby` passed to them with their own ids, so the row
  // adds its description's id to the control after each render instead.
  useEffect(() => {
    const control = row.current?.querySelector(CONTROL);
    if (!description || !control) return;
    const ids = (control.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    if (!ids.includes(descriptionId))
      control.setAttribute('aria-describedby', [...ids, descriptionId].join(' '));
  });
  const text = (
    <Box flex={1} miw={SETTING_TEXT_MIN_WIDTH}>
      <Group gap={4} wrap="nowrap">
        <Text size="sm" fw={500}>
          {label}
        </Text>
        {help ? <HelpHint label={label}>{help}</HelpHint> : null}
      </Group>
      {description ? (
        <Text size="xs" c="dimmed" id={descriptionId}>
          {description}
        </Text>
      ) : null}
    </Box>
  );
  return (
    <Box px="md" py="sm" ref={row}>
      {stacked ? (
        <Stack gap="xs">
          {text}
          {children}
        </Stack>
      ) : (
        <Group justify="space-between" wrap="nowrap" gap="xl">
          {text}
          {/* Every row in a card has the same width, so a column that gives way in a narrow window still lines up. */}
          <Box
            style={{
              flex: `0 1 ${String(SETTING_CONTROL_WIDTH)}px`,
              minWidth: SETTING_CONTROL_MIN_WIDTH,
            }}
          >
            {children}
          </Box>
        </Group>
      )}
      {below === undefined ? null : <Box mt="xs">{below}</Box>}
    </Box>
  );
}
