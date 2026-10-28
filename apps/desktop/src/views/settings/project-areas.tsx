import { ProjectPatch, type ProjectDto } from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Button,
  Code,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { usePatchProject } from '../../daemon/queries';
import { describePathPattern } from './path-pattern';

interface AreaDraft {
  readonly name: string;
  readonly paths: string;
}
interface HazardDraft extends AreaDraft {
  readonly commands: string;
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

const areaDrafts = (project: ProjectDto): AreaDraft[] =>
  project.areas.map((a) => ({ name: a.name, paths: a.globs.join('\n') }));
const hazardDrafts = (project: ProjectDto): HazardDraft[] =>
  project.hazards.map((h) => ({
    name: h.name,
    paths: h.globs.join('\n'),
    commands: h.commands.join('\n'),
  }));

/** The patch for the drafts, or the first thing wrong with them. */
function toPatch(
  areas: readonly AreaDraft[],
  hazards: readonly HazardDraft[],
): { readonly patch: ProjectPatch } | { readonly error: string } {
  const parsed = ProjectPatch.safeParse({
    areas: areas.map((a) => ({ name: a.name.trim(), globs: lines(a.paths) })),
    hazards: hazards.map((h) => ({
      name: h.name.trim(),
      globs: lines(h.paths),
      commands: lines(h.commands),
    })),
  });
  if (parsed.success) return { patch: parsed.data };
  const issue = parsed.error.issues[0];
  const [list, index, field] = issue?.path ?? [];
  const where =
    typeof index === 'number' && (list === 'areas' || list === 'hazards')
      ? `${list === 'areas' ? 'Area' : 'Hazard'} ${String(index + 1)}${field === 'globs' ? ' paths' : field === 'name' ? ' name' : ''}`
      : 'Areas and hazards';
  return { error: `${where}: ${issue?.message ?? 'is not valid'}` };
}

function PathExamples({ paths }: { readonly paths: string }) {
  return (
    <Stack gap={2}>
      {lines(paths).map((glob) => {
        const { words, example } = describePathPattern(glob);
        return (
          <Text key={glob} size="xs" c="dimmed">
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
  const changed =
    JSON.stringify([areas, hazards]) !==
    JSON.stringify([areaDrafts(project), hazardDrafts(project)]);

  const save = () => {
    const result = toPatch(areas, hazards);
    if ('error' in result) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    patch.mutate(result.patch);
  };
  const setArea = (index: number, next: Partial<AreaDraft>) => {
    setAreas((all) => all.map((a, i) => (i === index ? { ...a, ...next } : a)));
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
                : `Tasks in "${area.name.trim()}" may change files in ${
                    lines(area.paths)
                      .map((g) => describePathPattern(g).words)
                      .join('; ') || 'no paths yet'
                  }.`}
            </Text>
            <PathExamples paths={area.paths} />
          </Stack>
        ))}
        <Group>
          <Button
            variant="light"
            onClick={() => {
              setAreas((all) => [...all, { name: '', paths: '' }]);
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
                  }. Commands go one per line, as the start of a command such as "pnpm add".`}
            </Text>
            <PathExamples paths={hazard.paths} />
          </Stack>
        ))}
        <Group>
          <Button
            variant="light"
            onClick={() => {
              setHazards((all) => [...all, { name: '', paths: '', commands: '' }]);
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
