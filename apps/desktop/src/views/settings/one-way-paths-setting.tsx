import type { ProjectDto } from '@10db/contracts';
import { Button, Group, Textarea } from '@mantine/core';
import { useState } from 'react';
import { useOneWayPaths, useSetOneWayPaths } from '../../daemon/shape-measures-queries';
import { SettingRow } from './setting-row';

const MONO_INPUT = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

export const ONE_WAY_PATHS_LABEL = 'One-way paths';

const toLines = (paths: readonly string[]): string => paths.join('\n');

const fromLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/**
 * Shape spec §7: the file globs a Shape effort must write a spec before converting when a task
 * touches them (a schema, a migration, a public contract). One glob per line.
 */
export function OneWayPathsSetting({ project }: { readonly project: ProjectDto }) {
  const setting = useOneWayPaths(project.id);
  const set = useSetOneWayPaths(project.id);
  const [draft, setDraft] = useState<string | null>(null);
  const saved = setting.data === undefined ? '' : toLines(setting.data.paths);
  const text = draft ?? saved;
  const changed = draft !== null && draft !== saved;
  return (
    <SettingRow
      label={ONE_WAY_PATHS_LABEL}
      description="Files that make Plan write a spec before Convert."
      help="A task that touches a file matching one of these globs, one per line, makes Plan write a spec with scope and engineering review before Convert. You can still pin a task to direct."
      stacked
    >
      <Group align="flex-end" wrap="nowrap" gap="sm">
        <Textarea
          aria-label={ONE_WAY_PATHS_LABEL}
          placeholder="One pattern per line, such as packages/db/drizzle/**"
          styles={MONO_INPUT}
          style={{ flex: 1 }}
          autosize
          minRows={2}
          value={text}
          disabled={setting.data === undefined}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
          }}
        />
        <Button
          variant="default"
          size="compact-md"
          disabled={!changed || set.isPending}
          onClick={() => {
            set.mutate(fromLines(text), {
              onSuccess: () => {
                setDraft(null);
              },
            });
          }}
        >
          Save One-Way Paths
        </Button>
      </Group>
    </SettingRow>
  );
}
