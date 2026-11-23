import { AreaRole } from '@10db/contracts';
import {
  Accordion,
  ActionIcon,
  Badge,
  Center,
  Checkbox,
  Code,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { AreaRoleFields, type RoleChoice } from './area-role-fields';
import { HelpHint } from './help-hint';
import { describePathPattern } from './path-pattern';

export interface PathsDraft {
  readonly name: string;
  readonly paths: string;
}
export interface AreaDraft extends PathsDraft {
  /** The project's catch-all: a file no other area holds falls in it. At most one area. */
  readonly catchAll: boolean;
  readonly role: RoleChoice;
  /** A page's route; kept while the role changes, sent only for a page. */
  readonly route: string;
  /** A page's label; kept while the role changes, sent only for a page. */
  readonly label: string;
}
export interface HazardDraft extends PathsDraft {
  readonly perCopy: boolean;
  readonly commands: string;
}

export const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** A badge as wide as its word; a table or a narrow row never cuts it to "AC…". */
const WHOLE = { minWidth: 'max-content' } as const;
const WHOLE_LABEL = { label: { overflow: 'visible', textOverflow: 'clip' } } as const;

function Pill({
  children,
  color,
}: {
  readonly children: ReactNode;
  readonly color?: string | undefined;
}) {
  return (
    <Badge size="sm" variant="light" color={color ?? 'gray'} style={WHOLE} styles={WHOLE_LABEL}>
      {children}
    </Badge>
  );
}

const SHOWN_PATHS = 2;

/** A pattern's chips in a summary row; hovering one says what it means. */
function PathChips({ paths }: { readonly paths: string }) {
  const all = lines(paths);
  if (all.length === 0) return null;
  return (
    <Group gap={4} wrap="wrap">
      {all.slice(0, SHOWN_PATHS).map((glob, index) => (
        <Tooltip key={`${String(index)}-${glob}`} label={describePathPattern(glob).words}>
          <Code>{glob}</Code>
        </Tooltip>
      ))}
      {all.length > SHOWN_PATHS ? (
        <Text size="xs" c="dimmed">{`+${String(all.length - SHOWN_PATHS)} more`}</Text>
      ) : null}
    </Group>
  );
}

/** One dimmed line per pattern: what it means in words. */
function PathMeanings({ paths }: { readonly paths: string }) {
  const all = lines(paths);
  if (all.length === 0) return null;
  return (
    <Stack gap={2}>
      {all.map((glob, index) => (
        <Text key={`${String(index)}-${glob}`} size="xs" c="dimmed">
          <Code>{glob}</Code>
          {` ${describePathPattern(glob).words}`}
        </Text>
      ))}
    </Stack>
  );
}

/** One accordion item: a summary row that opens the editor, and the remove button beside it. */
function RowShell({
  value,
  noun,
  number,
  summary,
  onRemove,
  children,
}: {
  readonly value: string;
  readonly noun: 'area' | 'hazard';
  readonly number: number;
  readonly summary: ReactNode;
  readonly onRemove: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Accordion.Item value={value}>
      <Center>
        <Accordion.Control>{summary}</Accordion.Control>
        <Tooltip label={`Remove ${noun}`}>
          <ActionIcon
            aria-label={`Remove ${noun} ${String(number)}`}
            variant="subtle"
            color="gray"
            mr="md"
            onClick={onRemove}
          >
            <IconX size={16} aria-hidden />
          </ActionIcon>
        </Tooltip>
      </Center>
      <Accordion.Panel>{children}</Accordion.Panel>
    </Accordion.Item>
  );
}

export function AreaRow({
  index,
  area,
  onChange,
  onCatchAll,
  onRemove,
}: {
  readonly index: number;
  readonly area: AreaDraft;
  readonly onChange: (next: Partial<AreaDraft>) => void;
  readonly onCatchAll: (catchAll: boolean) => void;
  readonly onRemove: () => void;
}) {
  const n = String(index + 1);
  const name = area.name.trim();
  return (
    <RowShell
      value={String(index)}
      noun="area"
      number={index + 1}
      onRemove={onRemove}
      summary={
        <Group gap="sm" wrap="wrap">
          <Text size="sm" fw={500} {...(name === '' ? { c: 'dimmed' } : {})}>
            {name === '' ? 'Unnamed Area' : name}
          </Text>
          {area.role === AreaRole.Page ? (
            <Pill color="blue">
              {area.route.trim() === '' ? 'Page' : `Page ${area.route.trim()}`}
            </Pill>
          ) : null}
          {area.role === AreaRole.Shared ? <Pill color="grape">Shared</Pill> : null}
          {area.catchAll ? <Pill color="orange">Catch-All</Pill> : null}
          <PathChips paths={area.paths} />
        </Group>
      }
    >
      <Stack gap="sm">
        <Group align="flex-start" wrap="nowrap">
          <TextInput
            label="Name"
            aria-label={`Area ${n} name`}
            placeholder="name"
            w={200}
            value={area.name}
            onChange={(e) => {
              onChange({ name: e.currentTarget.value });
            }}
          />
          <Textarea
            label="Paths"
            aria-label={`Area ${n} paths`}
            placeholder="src/api/**"
            description="One pattern per line"
            autosize
            minRows={1}
            style={{ flex: 1 }}
            value={area.paths}
            onChange={(e) => {
              onChange({ paths: e.currentTarget.value });
            }}
          />
        </Group>
        <PathMeanings paths={area.paths} />
        <Group gap={4} wrap="nowrap">
          <Checkbox
            size="xs"
            aria-label={`Area ${n} is the catch-all`}
            label="Catch-All"
            checked={area.catchAll}
            onChange={(e) => {
              onCatchAll(e.currentTarget.checked);
            }}
          />
          <HelpHint label="Catch-All">
            Holds every file no other area holds, such as a new package, app or folder, so a task
            that adds one can still change it. A file another area holds is never in the catch-all.
            Only one area can be.
          </HelpHint>
        </Group>
        <AreaRoleFields
          index={index + 1}
          name={area.name}
          role={area.role}
          route={area.route}
          label={area.label}
          onChange={onChange}
        />
      </Stack>
    </RowShell>
  );
}

export function HazardRow({
  index,
  hazard,
  onChange,
  onRemove,
}: {
  readonly index: number;
  readonly hazard: HazardDraft;
  readonly onChange: (next: Partial<HazardDraft>) => void;
  readonly onRemove: () => void;
}) {
  const n = String(index + 1);
  const name = hazard.name.trim();
  const commands = lines(hazard.commands).length;
  return (
    <RowShell
      value={String(index)}
      noun="hazard"
      number={index + 1}
      onRemove={onRemove}
      summary={
        <Group gap="sm" wrap="wrap">
          <Text size="sm" fw={500} {...(name === '' ? { c: 'dimmed' } : {})}>
            {name === '' ? 'Unnamed Hazard' : name}
          </Text>
          {hazard.perCopy ? <Pill color="teal">Per Copy</Pill> : null}
          {commands > 0 ? (
            <Pill>{commands === 1 ? '1 Command' : `${String(commands)} Commands`}</Pill>
          ) : null}
          <PathChips paths={hazard.paths} />
        </Group>
      }
    >
      <Stack gap="sm">
        <Group align="flex-start" wrap="nowrap">
          <TextInput
            label="Name"
            aria-label={`Hazard ${n} name`}
            placeholder="name"
            w={200}
            value={hazard.name}
            onChange={(e) => {
              onChange({ name: e.currentTarget.value });
            }}
          />
          <Textarea
            label="Paths"
            aria-label={`Hazard ${n} paths`}
            placeholder="**/package.json"
            description="One pattern per line"
            autosize
            minRows={1}
            style={{ flex: 1 }}
            value={hazard.paths}
            onChange={(e) => {
              onChange({ paths: e.currentTarget.value });
            }}
          />
          <Textarea
            label="Commands"
            aria-label={`Hazard ${n} commands`}
            placeholder="pnpm add"
            description="One per line, from the start"
            autosize
            minRows={1}
            style={{ flex: 1 }}
            value={hazard.commands}
            onChange={(e) => {
              onChange({ commands: e.currentTarget.value });
            }}
          />
        </Group>
        <PathMeanings paths={hazard.paths} />
        <Group gap={4} wrap="nowrap">
          <Checkbox
            size="xs"
            aria-label={`Hazard ${n} is held per copy`}
            label="Held Per Copy"
            checked={hazard.perCopy}
            onChange={(e) => {
              onChange({ perCopy: e.currentTarget.checked });
            }}
          />
          <HelpHint label="Held Per Copy">
            Tasks working in separate copies of the project (worktrees) may change these files at
            the same time, and a clash is settled when their pull requests merge. Leave it off for
            something every copy shares, such as a database or a port.
          </HelpHint>
        </Group>
      </Stack>
    </RowShell>
  );
}
