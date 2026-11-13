import type { ProjectDto } from '@10db/contracts';
import { Button, Stack, Textarea } from '@mantine/core';
import { useState } from 'react';
import { useOneWayPaths, useSetOneWayPaths } from '../../daemon/shape-measures-queries';
import { SettingRow, SettingsCard } from './setting-row';

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
    <SettingsCard>
      <SettingRow
        label={ONE_WAY_PATHS_LABEL}
        description="A task that touches a file matching one of these globs, one per line, makes Plan write a spec with scope and engineering review before Convert. You can still pin a task to direct."
        stacked
      >
        <Stack gap="xs">
          <Textarea
            aria-label={ONE_WAY_PATHS_LABEL}
            autosize
            minRows={3}
            value={text}
            disabled={setting.data === undefined}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
            }}
          />
          <Button
            size="xs"
            w="fit-content"
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
        </Stack>
      </SettingRow>
    </SettingsCard>
  );
}
