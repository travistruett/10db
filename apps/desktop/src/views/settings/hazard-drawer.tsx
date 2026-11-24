import type { ProjectDto } from '@10db/contracts';
import { Alert, Button, Input, SegmentedControl, Stack, Textarea, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { EMPTY_HAZARD, hazardDraft, hazardOf, lines, type HazardDraft } from './list-drafts';
import { ChangedAlert, PathMeanings } from './table-cells';
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
  onDirty,
}: {
  readonly project: ProjectDto;
  readonly hazard: StoredHazard | null;
  readonly onClose: () => void;
  /** Told whether the draft differs from the row as it was opened. */
  readonly onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<HazardDraft>(() =>
    hazard === null ? EMPTY_HAZARD : hazardDraft(hazard),
  );
  const { save, saving, problem, clear } = useListPatch(project);
  const [gone, setGone] = useState(false);
  // The row as it was when the drawer opened (or last showed the latest); a save is refused when it differs.
  const [base, setBase] = useState(hazard);
  const [changed, setChanged] = useState(false);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(base === null ? EMPTY_HAZARD : hazardDraft(base));
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(
    () => () => {
      onDirty(false);
    },
    [onDirty],
  );
  const change = (next: Partial<HazardDraft>) => {
    clear();
    setDraft((d) => ({ ...d, ...next }));
  };
  const submit = () => {
    const next = hazardOf(draft);
    const index = base === null ? -1 : project.hazards.findIndex((x) => x.name === base.name);
    if (base !== null && index < 0) {
      setGone(true);
      return;
    }
    const current = project.hazards[index];
    if (base !== null && JSON.stringify(current) !== JSON.stringify(base)) {
      setChanged(true);
      return;
    }
    setGone(false);
    setChanged(false);
    save(
      {
        hazards:
          hazard === null
            ? [...project.hazards, next]
            : project.hazards.map((h, i) => (i === index ? next : h)),
      },
      onClose,
      next.name,
    );
  };
  const showLatest = () => {
    const current = project.hazards.find((x) => x.name === base?.name);
    if (current === undefined) return;
    clear();
    setBase(current);
    setDraft(hazardDraft(current));
    setChanged(false);
  };
  return (
    <SurfaceDrawer
      opened
      onClose={onClose}
      label={hazard === null ? 'Add Hazard' : `Hazard ${hazard.name}`}
      title={hazard === null ? 'Add Hazard' : hazard.name}
      closeOnClickOutside
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={submit}>
            {hazard === null ? 'Add Hazard' : 'Save Hazard'}
          </Button>
        </>
      }
    >
      <Stack gap="lg">
        <TextInput
          label="Name"
          description="What tasks take turns on."
          aria-label="Hazard name"
          placeholder="deps"
          data-autofocus
          value={draft.name}
          onChange={(e) => {
            change({ name: e.currentTarget.value });
          }}
        />
        <Stack gap={6}>
          <Textarea
            label="Paths"
            aria-label="Hazard paths"
            placeholder={'**/package.json\npnpm-lock.yaml'}
            description="Files only one task changes at a time, one pattern per line."
            autosize
            minRows={3}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            value={draft.paths}
            onChange={(e) => {
              change({ paths: e.currentTarget.value });
            }}
          />
          <PathMeanings paths={lines(draft.paths)} />
        </Stack>
        <Textarea
          label="Commands"
          aria-label="Hazard commands"
          placeholder={'pnpm add\npnpm install'}
          description="Commands that change those files, one per line, matched from the start."
          autosize
          minRows={3}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          value={draft.commands}
          onChange={(e) => {
            change({ commands: e.currentTarget.value });
          }}
        />
        <Input.Wrapper
          label="Scope"
          description={
            draft.perCopy
              ? 'Tasks in separate copies (worktrees) change these files at the same time; their pull requests settle a clash.'
              : 'One task at a time across the project. Right for something every copy shares, such as a database or a port.'
          }
        >
          <SegmentedControl
            mt={6}
            aria-label="Hazard scope"
            data={[
              { value: 'project', label: 'Project' },
              { value: 'copy', label: 'Per Copy' },
            ]}
            value={draft.perCopy ? 'copy' : 'project'}
            onChange={(value) => {
              change({ perCopy: value === 'copy' });
            }}
          />
        </Input.Wrapper>
        {changed ? <ChangedAlert noun="hazard" onShowLatest={showLatest} /> : null}
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
      </Stack>
    </SurfaceDrawer>
  );
}
