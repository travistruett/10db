import type { ProjectDto } from '@10db/contracts';
import { Alert, Button, Checkbox, Group, Stack, Textarea, TextInput } from '@mantine/core';
import { useState } from 'react';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { EMPTY_HAZARD, hazardDraft, hazardOf, lines, type HazardDraft } from './area-drafts';
import { HelpHint } from './help-hint';
import { PathMeanings } from './table-cells';
import { useListPatch } from './use-list-patch';

type StoredHazard = ProjectDto['hazards'][number];

/**
 * A hazard to change, or a new one when `hazard` is null. Save sends the project's whole hazard list
 * with only this one changed; a refusal's words stay in the drawer.
 */
export function HazardDrawer({
  project,
  hazard,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly hazard: StoredHazard | null;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<HazardDraft>(() =>
    hazard === null ? EMPTY_HAZARD : hazardDraft(hazard),
  );
  const { save, saving, problem } = useListPatch(project);
  const [gone, setGone] = useState(false);
  const change = (next: Partial<HazardDraft>) => {
    setDraft((d) => ({ ...d, ...next }));
  };
  const submit = () => {
    const next = hazardOf(draft);
    const index = hazard === null ? -1 : project.hazards.findIndex((h) => h.name === hazard.name);
    if (hazard !== null && index < 0) {
      setGone(true);
      return;
    }
    setGone(false);
    save(
      {
        hazards:
          hazard === null
            ? [...project.hazards, next]
            : project.hazards.map((h, i) => (i === index ? next : h)),
      },
      onClose,
    );
  };
  return (
    <SurfaceDrawer
      opened
      onClose={onClose}
      label={hazard === null ? 'Add Hazard' : `Hazard ${hazard.name}`}
      closeOnClickOutside
    >
      <Stack gap="md">
        <TextInput
          label="Name"
          aria-label="Hazard name"
          placeholder="name"
          data-autofocus
          value={draft.name}
          onChange={(e) => {
            change({ name: e.currentTarget.value });
          }}
        />
        <Textarea
          label="Paths"
          aria-label="Hazard paths"
          placeholder="**/package.json"
          description="One pattern per line"
          autosize
          minRows={2}
          value={draft.paths}
          onChange={(e) => {
            change({ paths: e.currentTarget.value });
          }}
        />
        <PathMeanings paths={lines(draft.paths)} />
        <Textarea
          label="Commands"
          aria-label="Hazard commands"
          placeholder="pnpm add"
          description="One per line, from the start"
          autosize
          minRows={2}
          value={draft.commands}
          onChange={(e) => {
            change({ commands: e.currentTarget.value });
          }}
        />
        <Group gap={4} wrap="nowrap">
          <Checkbox
            aria-label="Hazard is held per copy"
            label="Held Per Copy"
            checked={draft.perCopy}
            onChange={(e) => {
              change({ perCopy: e.currentTarget.checked });
            }}
          />
          <HelpHint label="Held Per Copy">
            Tasks working in separate copies of the project (worktrees) may change these files at
            the same time, and a clash is settled when their pull requests merge. Leave it off for
            something every copy shares, such as a database or a port.
          </HelpHint>
        </Group>
        {gone ? (
          <Alert color="yellow" title="This hazard changed">
            It was renamed or removed while this was open. Close this and open it again.
          </Alert>
        ) : null}
        {problem ? (
          <Alert color="red" title="Couldn't save the hazard">
            {problem}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={submit}>
            {hazard === null ? 'Add Hazard' : 'Save Hazard'}
          </Button>
        </Group>
      </Stack>
    </SurfaceDrawer>
  );
}
