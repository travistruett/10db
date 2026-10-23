import {
  BoardColumnName,
  type BoardColumnDto,
  type BoardColumnId,
  type ProjectDto,
} from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPencil, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import {
  useBoardColumns,
  useCreateBoardColumn,
  useDeleteBoardColumn,
  usePatchBoardColumn,
  useTasks,
} from '../../daemon/queries';

const PLANNED = 'planned';

function DeleteColumn({
  column,
  columns,
  parked,
  onClose,
}: {
  readonly column: BoardColumnDto;
  readonly columns: readonly BoardColumnDto[];
  /** How many tasks the column holds; the dialog only opens once that is known. */
  readonly parked: number;
  readonly onClose: () => void;
}) {
  const remove = useDeleteBoardColumn();
  const [target, setTarget] = useState<string | null>(null);
  const others = columns.filter((c) => c.id !== column.id);
  // The Select offers only these IDs and PLANNED, so the lookup gives back the branded ID without a cast.
  const byId = new Map<string, BoardColumnId>(others.map((c) => [c.id, c.id]));
  // No tasks to place means 'planned' is harmless; otherwise an unresolved choice stays undefined and blocks the delete.
  const moveTasksTo: BoardColumnId | typeof PLANNED | undefined =
    parked === 0 || target === PLANNED ? PLANNED : target === null ? undefined : byId.get(target);
  return (
    <Modal opened onClose={onClose} title={`Delete ${column.name}`}>
      <Stack>
        {parked > 0 ? (
          <>
            <Text size="sm">{`${column.name} holds ${String(parked)} task${parked === 1 ? '' : 's'}. Where should ${parked === 1 ? 'it' : 'they'} go?`}</Text>
            <Select
              label="Move its tasks to"
              data={[
                ...others.map((c) => ({ value: c.id, label: c.name })),
                { value: PLANNED, label: 'Planned (Backlog or Ready)' },
              ]}
              value={target}
              onChange={setTarget}
            />
          </>
        ) : (
          <Text size="sm">{`${column.name} is empty.`}</Text>
        )}
        {remove.error ? (
          <Alert color="red" title="Couldn't delete the column">
            {remove.error.message}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Keep it
          </Button>
          <Button
            color="red"
            disabled={moveTasksTo === undefined}
            loading={remove.isPending}
            onClick={() => {
              if (moveTasksTo !== undefined)
                remove.mutate({ id: column.id, moveTasksTo }, { onSuccess: onClose });
            }}
          >
            Delete column
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The project's human columns: add, rename, reorder, delete. */
export function BoardColumnsSection({ project }: { readonly project: ProjectDto }) {
  const columns = useBoardColumns(project.id);
  const tasks = useTasks(project.id);
  const create = useCreateBoardColumn(project.id);
  const patch = usePatchBoardColumn();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{
    readonly id: BoardColumnId;
    readonly name: string;
    readonly error: string | null;
  } | null>(null);
  const [deleting, setDeleting] = useState<BoardColumnDto | null>(null);
  const list = [...(columns.data ?? [])].sort((a, b) => a.position - b.position);
  const parkedIn = (id: BoardColumnId) =>
    (tasks.data ?? []).filter((t) => t.boardColumnId === id).length;

  function add() {
    const parsed = BoardColumnName.safeParse(name);
    if (!parsed.success) {
      setNameError(parsed.error.issues[0]?.message ?? 'Enter a name');
      return;
    }
    setNameError(null);
    create.mutate(
      { name: parsed.data },
      {
        onSuccess: () => {
          setName('');
        },
      },
    );
  }

  /** The same check as `add`, with the message on the rename field. */
  function rename(id: BoardColumnId, typed: string) {
    const parsed = BoardColumnName.safeParse(typed);
    if (!parsed.success) {
      setRenaming({ id, name: typed, error: parsed.error.issues[0]?.message ?? 'Enter a name' });
      return;
    }
    setRenaming({ id, name: typed, error: null });
    patch.mutate(
      { id, patch: { name: parsed.data } },
      {
        onSuccess: () => {
          setRenaming(null);
        },
      },
    );
  }

  return (
    <Stack maw={640}>
      <Text size="sm" c="dimmed">
        Tasks in these columns are parked: 10db never picks or starts them.
      </Text>
      <Text size="sm" c="dimmed">
        Backlog, Ready, In progress, Blocked and Done follow each task’s state and can’t be changed.
      </Text>
      <Table aria-label="Human columns" verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Tasks</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {list.map((column, i) => (
            <Table.Tr key={column.id}>
              <Table.Td>
                {renaming?.id === column.id ? (
                  <Group gap="xs">
                    <TextInput
                      size="sm"
                      aria-label={`Name for ${column.name}`}
                      value={renaming.name}
                      error={renaming.error}
                      onChange={(e) => {
                        setRenaming({ ...renaming, name: e.currentTarget.value });
                      }}
                    />
                    <Button
                      size="xs"
                      onClick={() => {
                        rename(column.id, renaming.name);
                      }}
                    >
                      Save name
                    </Button>
                  </Group>
                ) : (
                  column.name
                )}
              </Table.Td>
              <Table.Td>{parkedIn(column.id)}</Table.Td>
              <Table.Td>
                <Group gap={4}>
                  <ActionIcon
                    variant="subtle"
                    aria-label={`Rename ${column.name}`}
                    onClick={() => {
                      setRenaming({ id: column.id, name: column.name, error: null });
                    }}
                  >
                    <IconPencil size={16} stroke={1.5} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    aria-label={`Move ${column.name} up`}
                    disabled={i === 0}
                    onClick={() => {
                      patch.mutate({ id: column.id, patch: { position: i - 1 } });
                    }}
                  >
                    <IconArrowUp size={16} stroke={1.5} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    aria-label={`Move ${column.name} down`}
                    disabled={i === list.length - 1}
                    onClick={() => {
                      patch.mutate({ id: column.id, patch: { position: i + 1 } });
                    }}
                  >
                    <IconArrowDown size={16} stroke={1.5} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`Delete ${column.name}`}
                    disabled={!tasks.isSuccess}
                    onClick={() => {
                      setDeleting(column);
                    }}
                  >
                    <IconTrash size={16} stroke={1.5} />
                  </ActionIcon>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {list.length === 0 ? (
        <Text size="sm" c="dimmed">
          No human columns. Every task is planned.
        </Text>
      ) : null}
      {patch.error ? (
        <Alert color="red" title="Couldn't change the column">
          {patch.error.message}
        </Alert>
      ) : null}
      <Group align="flex-end">
        <TextInput
          label="New column"
          value={name}
          error={nameError}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
        />
        <Button onClick={add} loading={create.isPending}>
          Add column
        </Button>
      </Group>
      {create.error ? (
        <Alert color="red" title="Couldn't add the column">
          {create.error.message}
        </Alert>
      ) : null}
      {deleting && tasks.isSuccess ? (
        <DeleteColumn
          column={deleting}
          columns={list}
          parked={parkedIn(deleting.id)}
          onClose={() => {
            setDeleting(null);
          }}
        />
      ) : null}
    </Stack>
  );
}
