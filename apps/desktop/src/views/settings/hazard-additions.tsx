import { HazardEntryKind, type HazardAdditionDto, type ProjectDto } from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Code,
  Collapse,
  Group,
  Loader,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconArrowBackUp, IconChevronRight } from '@tabler/icons-react';
import { DataTable, type DataTableColumn } from 'mantine-datatable';
import { useState } from 'react';
import {
  useHazardAssessment,
  useUndoHazardAddition,
  type useLookAgainAtHazards,
} from '../../daemon/hazard-queries';
import { Pill } from './table-cells';
import { RaisedPanel } from '../../shell/raised-panel';

const KIND_LABELS: Readonly<Record<HazardEntryKind, string>> = {
  [HazardEntryKind.Command]: 'Command',
  [HazardEntryKind.Glob]: 'Path pattern',
};

/** Where 10db found an addition: the file, and the line when a line named it. */
export function foundIn(addition: HazardAdditionDto): string {
  const { file, line } = addition.evidence;
  return line === undefined ? `Found in ${file}` : `Found in ${file}, line ${String(line)}`;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * What Look Again found, and how many removals wait on the Inbox: lines under the Hazards heading. Removals are
 * never applied here; they wait on one Inbox card.
 */
export function HazardLookStatus({
  project,
  look,
}: {
  readonly project: ProjectDto;
  readonly look: ReturnType<typeof useLookAgainAtHazards>;
}) {
  const assessment = useHazardAssessment(project.id);
  const waiting = Math.max(
    look.data?.ok === true ? look.data.assessment.pendingRemovals : 0,
    assessment.data?.pendingRemovals ?? 0,
  );
  return (
    <>
      {look.isPending ? (
        <Group gap="xs" role="status">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Reading the repository for lockfiles, migrations and the commands that change them…
          </Text>
        </Group>
      ) : null}
      {look.data?.ok === true ? (
        <Text size="sm">
          {look.data.added === 0
            ? 'Looked again: nothing new to add.'
            : `Looked again. Added ${plural(look.data.added, 'thing', 'things')}.`}
        </Text>
      ) : null}
      {look.data?.ok === false ? (
        <Alert color="yellow" title="Nothing changed">
          {look.data.message}
        </Alert>
      ) : null}
      {look.error ? (
        <Alert color="red" title="Couldn't look again">
          {look.error.message}
        </Alert>
      ) : null}
      {waiting > 0 ? (
        <Text size="sm">
          {waiting === 1
            ? '1 change is waiting in the Inbox for your yes.'
            : `${String(waiting)} changes are waiting in the Inbox for your yes.`}
        </Text>
      ) : null}
    </>
  );
}

/**
 * What 10db worked out about the project's hazards from its repository and added by itself, folded to one line
 * under the Hazards table. Opened, a table: the hazard each went to, the command or pattern, why, and where it
 * was found, each with an Undo.
 */
export function FoundByTendb({ project }: { readonly project: ProjectDto }) {
  const assessment = useHazardAssessment(project.id);
  const undo = useUndoHazardAddition(project.id);
  const [opened, setOpened] = useState(false);
  const additions = assessment.data?.additions ?? [];
  if (additions.length === 0) return null;
  const columns: DataTableColumn<HazardAdditionDto>[] = [
    {
      accessor: 'hazard',
      title: 'Added To',
      noWrap: true,
      render: (addition) => <Pill>{addition.hazard}</Pill>,
    },
    {
      accessor: 'value',
      title: 'Command or Path',
      render: (addition) => (
        <Stack gap={2}>
          <Code style={{ width: 'fit-content' }}>{addition.value}</Code>
          <Text size="xs" c="dimmed">
            {KIND_LABELS[addition.kind]}
          </Text>
        </Stack>
      ),
    },
    {
      accessor: 'reason',
      title: 'Why',
      render: (addition) => (
        <Stack gap={2}>
          <Text size="sm">{addition.reason}</Text>
          <Text size="xs" c="dimmed">
            {foundIn(addition)}
          </Text>
        </Stack>
      ),
    },
    {
      accessor: 'undo',
      title: '',
      width: 52,
      textAlign: 'right',
      render: (addition) => (
        <Tooltip label="Undo">
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`Undo ${addition.value}`}
            disabled={undo.isPending}
            onClick={() => {
              undo.mutate(addition.id);
            }}
          >
            <IconArrowBackUp size={16} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      ),
    },
  ];
  return (
    <Stack gap="xs">
      <UnstyledButton
        aria-expanded={opened}
        onClick={() => {
          setOpened((o) => !o);
        }}
      >
        <Group gap={6} wrap="nowrap">
          <IconChevronRight
            size={14}
            stroke={1.8}
            style={{
              transform: opened ? 'rotate(90deg)' : undefined,
              transition: 'transform 120ms',
            }}
          />
          <Text size="sm" fw={500}>
            Found by 10db
          </Text>
          <Text size="sm" c="dimmed">
            {plural(additions.length, 'addition', 'additions')}
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={opened}>
        <RaisedPanel>
          <DataTable<HazardAdditionDto>
            aria-label="Found by 10db"
            records={additions}
            columns={columns}
            backgroundColor="transparent"
            verticalSpacing="xs"
            horizontalSpacing="md"
          />
        </RaisedPanel>
      </Collapse>
      {undo.error ? (
        <Alert color="red" title="Couldn't undo that">
          {undo.error.message}
        </Alert>
      ) : null}
    </Stack>
  );
}
