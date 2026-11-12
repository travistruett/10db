import { hazardScope, HazardScope, ProjectPatch, type ProjectDto } from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Code,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { usePatchProject } from '../../daemon/queries';
import { AreaRoleFields, roleFields, type RoleChoice } from './area-role-fields';
import { HazardAdditions } from './hazard-additions';
import { describePathPattern } from './path-pattern';

interface PathsDraft {
  readonly name: string;
  readonly paths: string;
}
interface AreaDraft extends PathsDraft {
  /** The project's catch-all: a file no other area holds falls in it. At most one area. */
  readonly catchAll: boolean;
  readonly role: RoleChoice;
  /** A page's route; kept while the role changes, sent only for a page. */
  readonly route: string;
}
interface HazardDraft extends PathsDraft {
  readonly perCopy: boolean;
  readonly commands: string;
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

const areaDrafts = (project: ProjectDto): AreaDraft[] =>
  project.areas.map((a) => ({
    name: a.name,
    paths: a.globs.join('\n'),
    catchAll: a.catchAll === true,
    role: a.role ?? '',
    route: a.route ?? '',
  }));
const hazardDrafts = (project: ProjectDto): HazardDraft[] =>
  project.hazards.map((h) => ({
    name: h.name,
    paths: h.globs.join('\n'),
    commands: h.commands.join('\n'),
    perCopy: hazardScope(h) === HazardScope.Copy,
  }));

/** The patch for the drafts, or the first thing wrong with them. */
function toPatch(
  areas: readonly AreaDraft[],
  hazards: readonly HazardDraft[],
): { readonly patch: ProjectPatch } | { readonly error: string } {
  const parsed = ProjectPatch.safeParse({
    areas: areas.map((a) => ({
      name: a.name.trim(),
      globs: lines(a.paths),
      ...(a.catchAll ? { catchAll: true } : {}),
      ...roleFields(a.role, a.route),
    })),
    hazards: hazards.map((h) => ({
      name: h.name.trim(),
      globs: lines(h.paths),
      commands: lines(h.commands),
      scope: h.perCopy ? HazardScope.Copy : HazardScope.Project,
    })),
  });
  if (parsed.success) return { patch: parsed.data };
  const issue = parsed.error.issues[0];
  const [list, index, field] = issue?.path ?? [];
  const where =
    typeof index === 'number' && (list === 'areas' || list === 'hazards')
      ? `${list === 'areas' ? 'Area' : 'Hazard'} ${String(index + 1)}${field === 'globs' ? ' paths' : field === 'name' ? ' name' : field === 'route' ? ' route' : ''}`
      : 'Areas and hazards';
  return { error: `${where}: ${issue?.message ?? 'is not valid'}` };
}

function PathExamples({ paths }: { readonly paths: string }) {
  return (
    <Stack gap={2}>
      {lines(paths).map((glob, index) => {
        const { words, example } = describePathPattern(glob);
        return (
          <Text key={`${String(index)}-${glob}`} size="xs" c="dimmed">
            <Code>{glob}</Code>
            {` ${words}. Example: ${example}`}
          </Text>
        );
      })}
    </Stack>
  );
}

/** Add, rename, remove and edit the project's areas and hazards, saved in one patch to the project. */
export function ProjectAreas({ project }: { readonly project: ProjectDto }) {
  const patch = usePatchProject(project.id);
  const [areas, setAreas] = useState(() => areaDrafts(project));
  const [hazards, setHazards] = useState(() => hazardDrafts(project));
  const [problem, setProblem] = useState<string | null>(null);
  // 10db adds to the hazards by itself, so the project can change while this page is open. Drafts the
  // builder has not touched follow it; edited ones stay, with a note that Save would replace the change.
  const stored = JSON.stringify([areaDrafts(project), hazardDrafts(project)]);
  const [seen, setSeen] = useState(stored);
  const [outdated, setOutdated] = useState(false);
  if (stored !== seen) {
    setSeen(stored);
    const current = JSON.stringify([areas, hazards]);
    if (current === seen) {
      setAreas(areaDrafts(project));
      setHazards(hazardDrafts(project));
    } else if (current !== stored) {
      setOutdated(true);
    }
  }
  const changed = JSON.stringify([areas, hazards]) !== stored;

  const save = () => {
    const result = toPatch(areas, hazards);
    if ('error' in result) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    setOutdated(false);
    patch.mutate(result.patch);
  };
  const setArea = (index: number, next: Partial<AreaDraft>) => {
    setAreas((all) => all.map((a, i) => (i === index ? { ...a, ...next } : a)));
  };
  /** Only one area is the catch-all, so choosing one clears the others. */
  const setCatchAll = (index: number, catchAll: boolean) => {
    setAreas((all) =>
      all.map((a, i) =>
        i === index ? { ...a, catchAll } : catchAll ? { ...a, catchAll: false } : a,
      ),
    );
  };
  const setHazard = (index: number, next: Partial<HazardDraft>) => {
    setHazards((all) => all.map((h, i) => (i === index ? { ...h, ...next } : h)));
  };

  return (
    <Stack>
      <Stack gap="xs">
        <Text fw={600}>Areas</Text>
        <Text size="sm" c="dimmed">
          An area is a part of the project. Tasks in different areas can run at the same time, and a
          task may change only the files of the areas it names. Paths are folder patterns, one per
          line: <Code>src/api/**</Code> means everything inside src/api/.
        </Text>
        {areas.map((area, index) => (
          <Stack key={index} gap={4}>
            <Group align="flex-start" wrap="nowrap">
              <TextInput
                aria-label={`Area ${String(index + 1)} name`}
                placeholder="name"
                value={area.name}
                onChange={(e) => {
                  setArea(index, { name: e.currentTarget.value });
                }}
              />
              <Textarea
                aria-label={`Area ${String(index + 1)} paths`}
                placeholder="src/api/**"
                autosize
                minRows={1}
                style={{ flex: 1 }}
                value={area.paths}
                onChange={(e) => {
                  setArea(index, { paths: e.currentTarget.value });
                }}
              />
              <ActionIcon
                aria-label={`Remove area ${String(index + 1)}`}
                variant="subtle"
                color="red"
                onClick={() => {
                  setAreas((all) => all.filter((_, i) => i !== index));
                }}
              >
                ×
              </ActionIcon>
            </Group>
            <Text size="xs">
              {area.name.trim() === ''
                ? 'Name this area.'
                : area.catchAll
                  ? `Tasks in "${area.name.trim()}" may change every file no other area holds.`
                  : `Tasks in "${area.name.trim()}" may change files in ${
                      lines(area.paths)
                        .map((g) => describePathPattern(g).words)
                        .join('; ') || 'no paths yet'
                    }.`}
            </Text>
            <Checkbox
              size="xs"
              aria-label={`Area ${String(index + 1)} is the catch-all`}
              label="Catch-all: holds every file no other area holds, such as a new package, app or folder, so a task that adds one can still change it. A file another area holds is never in the catch-all. Only one area can be."
              checked={area.catchAll}
              onChange={(e) => {
                setCatchAll(index, e.currentTarget.checked);
              }}
            />
            <AreaRoleFields
              index={index + 1}
              role={area.role}
              route={area.route}
              onChange={(next) => {
                setArea(index, next);
              }}
            />
            <PathExamples paths={area.paths} />
          </Stack>
        ))}
        <Group>
          <Button
            variant="light"
            onClick={() => {
              setAreas((all) => [
                ...all,
                { name: '', paths: '', catchAll: false, role: '', route: '' },
              ]);
            }}
          >
            Add area
          </Button>
        </Group>
      </Stack>

      <Stack gap="xs">
        <Text fw={600}>Hazards</Text>
        <Text size="sm" c="dimmed">
          A hazard is a set of files only one task changes at a time, such as lockfiles or
          migrations. A task that touches one, or runs one of its commands, waits for the task that
          holds it.
        </Text>
        <HazardAdditions project={project} />
        {outdated ? (
          <Alert color="yellow" title="The hazards changed while you were editing">
            Saving now replaces what changed.{' '}
            <Button
              variant="subtle"
              size="compact-sm"
              onClick={() => {
                setAreas(areaDrafts(project));
                setHazards(hazardDrafts(project));
                setOutdated(false);
              }}
            >
              Discard my edits and show the latest
            </Button>
          </Alert>
        ) : null}
        {hazards.length === 0 ? <Text c="dimmed">No hazards.</Text> : null}
        {hazards.map((hazard, index) => (
          <Stack key={index} gap={4}>
            <Group align="flex-start" wrap="nowrap">
              <TextInput
                aria-label={`Hazard ${String(index + 1)} name`}
                placeholder="name"
                value={hazard.name}
                onChange={(e) => {
                  setHazard(index, { name: e.currentTarget.value });
                }}
              />
              <Textarea
                aria-label={`Hazard ${String(index + 1)} paths`}
                placeholder="**/package.json"
                autosize
                minRows={1}
                style={{ flex: 1 }}
                value={hazard.paths}
                onChange={(e) => {
                  setHazard(index, { paths: e.currentTarget.value });
                }}
              />
              <Textarea
                aria-label={`Hazard ${String(index + 1)} commands`}
                placeholder="pnpm add"
                autosize
                minRows={1}
                style={{ flex: 1 }}
                value={hazard.commands}
                onChange={(e) => {
                  setHazard(index, { commands: e.currentTarget.value });
                }}
              />
              <ActionIcon
                aria-label={`Remove hazard ${String(index + 1)}`}
                variant="subtle"
                color="red"
                onClick={() => {
                  setHazards((all) => all.filter((_, i) => i !== index));
                }}
              >
                ×
              </ActionIcon>
            </Group>
            <Text size="xs">
              {hazard.name.trim() === ''
                ? 'Name this hazard.'
                : `Only one task at a time may change these files${
                    lines(hazard.commands).length > 0 ? ' or run these commands' : ''
                  }${hazard.perCopy ? ' in the same copy of the project' : ''}. Commands go one per line, as the start of a command such as "pnpm add".`}
            </Text>
            <Checkbox
              size="xs"
              aria-label={`Hazard ${String(index + 1)} is held per copy`}
              label="Held per copy: tasks working in separate copies of the project (worktrees) may change these files at the same time, and a clash is settled when their pull requests merge. Leave it off for something every copy shares, such as a database or a port."
              checked={hazard.perCopy}
              onChange={(e) => {
                setHazard(index, { perCopy: e.currentTarget.checked });
              }}
            />
            <PathExamples paths={hazard.paths} />
          </Stack>
        ))}
        <Group>
          <Button
            variant="light"
            onClick={() => {
              setHazards((all) => [...all, { name: '', paths: '', commands: '', perCopy: false }]);
            }}
          >
            Add hazard
          </Button>
        </Group>
      </Stack>

      {problem ? (
        <Alert color="red" title="Check the areas and hazards">
          {problem}
        </Alert>
      ) : null}
      {patch.error ? (
        <Alert color="red" title="Couldn't save the areas and hazards">
          {patch.error.message}
        </Alert>
      ) : null}
      <Group>
        <Button disabled={!changed || patch.isPending} loading={patch.isPending} onClick={save}>
          Save areas and hazards
        </Button>
      </Group>
    </Stack>
  );
}
