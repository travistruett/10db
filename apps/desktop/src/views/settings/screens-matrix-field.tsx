import { ScreenTheme } from '@10db/contracts';
import { Button, Checkbox, Group, NumberInput, Stack, Text } from '@mantine/core';
import type { ScreensValues, ViewportValues } from './general-values';

// Workbench spec §10: the viewports and themes each page is pictured in. The form holds what is typed;
// `checkGeneral` checks it with the contract's rules.

const MAX_VIEWPORTS = 3;
const THEMES = [
  { value: ScreenTheme.Default, label: "The app's own" },
  { value: ScreenTheme.Light, label: 'Light' },
  { value: ScreenTheme.Dark, label: 'Dark' },
] as const;

const asNumber = (value: number | string): number | '' => (typeof value === 'number' ? value : '');
const isTheme = (value: string): value is ScreenTheme =>
  THEMES.some((theme) => theme.value === value);

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
    <Stack gap="xs">
      {value.viewports.map((viewport, index) => {
        const n = String(index + 1);
        return (
          // A viewport has no id of its own; its place in the list is what the builder edits.
          <Group key={index} gap="xs" wrap="nowrap">
            <NumberInput
              aria-label={`Viewport ${n} width`}
              w={100}
              min={320}
              max={3840}
              value={viewport.width}
              onChange={(width) => {
                setViewport(index, { width: asNumber(width) });
              }}
            />
            <Text size="sm" aria-hidden>
              ×
            </Text>
            <NumberInput
              aria-label={`Viewport ${n} height`}
              w={100}
              min={320}
              max={2400}
              value={viewport.height}
              onChange={(height) => {
                setViewport(index, { height: asNumber(height) });
              }}
            />
            {value.viewports.length > 1 ? (
              <Button
                variant="subtle"
                size="compact-sm"
                aria-label={`Remove viewport ${n}`}
                onClick={() => {
                  onChange({ ...value, viewports: value.viewports.filter((_, i) => i !== index) });
                }}
              >
                Remove
              </Button>
            ) : null}
          </Group>
        );
      })}
      {value.viewports.length < MAX_VIEWPORTS ? (
        <Group>
          <Button
            variant="default"
            size="compact-sm"
            onClick={() => {
              onChange({ ...value, viewports: [...value.viewports, { width: '', height: '' }] });
            }}
          >
            Add Viewport
          </Button>
        </Group>
      ) : null}
      <Checkbox.Group
        aria-label="Themes"
        value={[...value.themes]}
        onChange={(themes) => {
          onChange({ ...value, themes: themes.filter(isTheme) });
        }}
      >
        <Group gap="md">
          {THEMES.map((theme) => (
            <Checkbox key={theme.value} value={theme.value} label={theme.label} />
          ))}
        </Group>
      </Checkbox.Group>
      {error === undefined ? null : (
        <Text size="xs" c="red" role="alert">
          {error}
        </Text>
      )}
    </Stack>
  );
}
