import type { ProjectDto } from '@10db/contracts';
import { Textarea } from '@mantine/core';
import { useOneWayPaths, useSetOneWayPaths } from '../../daemon/shape-measures-queries';
import { SettingRow } from './setting-row';
import { useDraft } from './settings-drafts';

const MONO_INPUT = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

export const ONE_WAY_PATHS_LABEL = 'One-Way Paths';

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
  // Compared as Save sends them, so a blank line or a trailing space is not an edit.
  const paths = useDraft({
    saved: setting.data === undefined ? undefined : toLines(setting.data.paths),
    save: (text) => set.mutateAsync(fromLines(text)),
    same: (a, b) => toLines(fromLines(a)) === toLines(fromLines(b)),
  });
  return (
    <SettingRow
      label={ONE_WAY_PATHS_LABEL}
      description="Files that make Plan write a spec before Convert."
      help="A task that touches a file matching one of these globs, one per line, makes Plan write a spec with scope and engineering review before Convert. You can still pin a task to direct."
      stacked
    >
      <Textarea
        aria-label={ONE_WAY_PATHS_LABEL}
        placeholder="One pattern per line, such as packages/db/drizzle/**"
        styles={MONO_INPUT}
        style={{ flex: 1 }}
        autosize
        minRows={2}
        value={paths.value ?? ''}
        disabled={setting.data === undefined}
        onChange={(event) => {
          paths.set(event.currentTarget.value);
        }}
      />
    </SettingRow>
  );
}
