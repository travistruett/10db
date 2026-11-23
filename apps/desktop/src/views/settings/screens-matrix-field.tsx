import { ScreenTheme } from '@10db/contracts';
import { ActionIcon, Chip, Group, NumberInput, Stack, Text, Tooltip } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { ScreensValues, ViewportValues } from './general-values';

// Workbench spec §10: the viewports and themes each page is pictured in. The form holds what is typed;
// `checkGeneral` checks it with the contract's rules.

const MAX_VIEWPORTS = 3;
const THEMES = [
  {
    value: ScreenTheme.Default,
    label: 'App Default',
    hint: 'However the app looks when it opens, without forcing light or dark.',
  },
  { value: ScreenTheme.Light, label: 'Light', hint: 'Forced to light.' },
  { value: ScreenTheme.Dark, label: 'Dark', hint: 'Forced to dark.' },
] as const;

const asNumber = (value: number | string): number | '' => (typeof value === 'number' ? value : '');
const isTheme = (value: string): value is ScreenTheme =>
  THEMES.some((theme) => theme.value === value);

/** One labelled line of the matrix: a small dimmed name over its controls. */
function MatrixLine({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Stack gap={6}>
      <Text size="xs" c="dimmed" fw={500}>
        {label}
      </Text>
      {children}
    </Stack>
  );
}

export function ScreensMatrixField({
  value,
  error,
  onChange,
}: {
  readonly value: ScreensValues;
  readonly error: string | undefined;
  readonly onChange: (next: ScreensValues) => void;
}) {
  const setViewport = (index: number, change: Partial<ViewportValues>) => {
    onChange({
      ...value,
      viewports: value.viewports.map((v, i) => (i === index ? { ...v, ...change } : v)),
    });
  };
  return (
    <Stack gap="md">
      <MatrixLine label="Viewports">
        <Group gap="md" wrap="wrap" align="center">
          {value.viewports.map((viewport, index) => {
            const n = String(index + 1);
            return (
              // A viewport has no id of its own; its place in the list is what the builder edits.
              <Group key={index} gap={6} wrap="nowrap">
                <NumberInput
                  aria-label={`Viewport ${n} width`}
                  size="xs"
                  w={84}
                  min={320}
                  max={3840}
                  value={viewport.width}
                  onChange={(width) => {
                    setViewport(index, { width: asNumber(width) });
                  }}
                />
                <Text size="sm" c="dimmed" aria-hidden>
                  ×
                </Text>
                <NumberInput
                  aria-label={`Viewport ${n} height`}
                  size="xs"
                  w={84}
                  min={320}
                  max={2400}
                  value={viewport.height}
                  onChange={(height) => {
                    setViewport(index, { height: asNumber(height) });
                  }}
                />
                {value.viewports.length > 1 ? (
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label={`Remove viewport ${n}`}
                    onClick={() => {
                      onChange({
                        ...value,
                        viewports: value.viewports.filter((_, i) => i !== index),
                      });
                    }}
                  >
                    <IconX size={14} stroke={1.5} />
                  </ActionIcon>
                ) : null}
              </Group>
            );
          })}
          {value.viewports.length < MAX_VIEWPORTS ? (
            <Tooltip label="Add Viewport">
              <ActionIcon
                variant="default"
                size="input-xs"
                aria-label="Add Viewport"
                onClick={() => {
                  onChange({
                    ...value,
                    viewports: [...value.viewports, { width: '', height: '' }],
                  });
                }}
              >
                <IconPlus size={14} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          ) : null}
        </Group>
      </MatrixLine>
      <MatrixLine label="Themes">
        <Chip.Group
          multiple
          value={[...value.themes]}
          onChange={(themes) => {
            onChange({ ...value, themes: themes.filter(isTheme) });
          }}
        >
          <Group gap="xs" aria-label="Themes" role="group">
            {THEMES.map((theme) => (
              <Tooltip key={theme.value} label={theme.hint}>
                <Chip value={theme.value} size="sm">
                  {theme.label}
                </Chip>
              </Tooltip>
            ))}
          </Group>
        </Chip.Group>
      </MatrixLine>
      {error === undefined ? null : (
        <Text size="xs" c="red" role="alert">
          {error}
        </Text>
      )}
    </Stack>
  );
}
