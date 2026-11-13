import type {
  AccountId,
  PersonaDto,
  PlaybookCellDto,
  ProjectId,
  RolePickDto,
} from '@10db/contracts';
import { Button, Group, Popover, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { usePersonas } from '../../daemon/persona-queries';
import { useSetPlaybook } from '../../daemon/playbook-queries';
import { formatCost } from './model-format';
import { settingSummary } from './model-setting-options';
import { CellFields } from './playbook-cell-fields';
import { isEmptyCell, ownCell, scopeSource } from './playbook-edits';
import { rigorLabel } from './rigor-labels';
import { ROLES } from './role-labels';

const roleLabel = (cell: PlaybookCellDto): string =>
  ROLES.find((r) => r.role === cell.role)?.label ?? cell.role;

/** What a cell resolves to on the account: the model and effort, or why nothing was chosen. */
function resolvedLine(pick: RolePickDto | undefined, names: ReadonlyMap<string, string>): string {
  if (pick === undefined) return 'Reading…';
  if (pick.model === null) return 'Nothing chosen';
  return `${names.get(pick.model) ?? pick.model}${pick.effort === null ? '' : ` · ${pick.effort}`}`;
}

/**
 * The cell as the table shows it, on two lines that wrap: the model it resolves to, then its effort and the
 * setting that made it.
 */
export function PlaybookCellButton({
  cell,
  pick,
  names,
  changedHere,
  onClick,
}: {
  readonly cell: PlaybookCellDto;
  readonly pick: RolePickDto | undefined;
  readonly names: ReadonlyMap<string, string>;
  readonly changedHere: boolean;
  readonly onClick: () => void;
}) {
  const model =
    pick === undefined
      ? 'Reading…'
      : pick.model === null
        ? 'Nothing chosen'
        : (names.get(pick.model) ?? pick.model);
  const setting = settingSummary(cell.model.value ?? { kind: 'automatic' }, names);
  const detail = `${pick?.effort == null ? '' : `${pick.effort} · `}${setting}${changedHere ? ' · set here' : ''}`;
  return (
    <UnstyledButton
      aria-label={`${rigorLabel(cell.rigor)} ${roleLabel(cell)}: ${model}, ${detail}`}
      onClick={onClick}
      style={{ display: 'block', width: '100%' }}
    >
      <Text size="sm" fw={500} {...(pick?.model === null ? { c: 'dimmed' } : {})}>
        {model}
      </Text>
      <Text size="xs" c="dimmed">
        {detail}
      </Text>
    </UnstyledButton>
  );
}

/**
 * A cell's editor: what it resolves to on the account and what that costs, then its persona, model and effort.
 * A change saves at once, and writes this scope's own fields only; Reset hands the cell back to the scope above.
 */
export function PlaybookCellEditor({
  cell,
  pick,
  names,
  projectId,
  accountId,
  children,
}: {
  readonly cell: PlaybookCellDto;
  readonly pick: RolePickDto | undefined;
  readonly names: ReadonlyMap<string, string>;
  readonly projectId: ProjectId | null;
  readonly accountId: AccountId | null;
  /** The button that opens the editor; it is given the open handler. */
  readonly children: (open: () => void) => ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  const personas: readonly PersonaDto[] = usePersonas().data ?? [];
  const set = useSetPlaybook(projectId);
  const own = ownCell(cell, scopeSource(projectId));
  const noneLabel = projectId === null ? '10db default' : 'Use global';
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={340}
      position="bottom-start"
      withArrow
      trapFocus
      shadow="md"
    >
      <Popover.Target>
        <div>
          {children(() => {
            setOpened((o) => !o);
          })}
        </div>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack
          gap="sm"
          role="dialog"
          aria-label={`${rigorLabel(cell.rigor)} ${roleLabel(cell)} cell`}
        >
          <Title order={5}>
            {rigorLabel(cell.rigor)} · {roleLabel(cell)}
          </Title>
          <Stack gap={2}>
            <Text size="sm" fw={500}>
              {resolvedLine(pick, names)}
            </Text>
            <Text size="xs" c="dimmed">
              {pick === undefined || pick.model === null
                ? (pick?.reason ?? '')
                : `${formatCost(pick.costPerTaskUsd)} per task. ${pick.reason}`}
            </Text>
          </Stack>
          <CellFields
            // A saved change remounts the fields, so a draft minimum never outlives the value it edited.
            key={JSON.stringify(own)}
            role={cell.role}
            value={own}
            personas={personas}
            accountIds={accountId === null ? null : [accountId]}
            noneLabel={noneLabel}
            comboboxProps={{ withinPortal: false }}
            onChange={(next) => {
              set.mutate({ cells: [{ rigor: cell.rigor, role: cell.role, ...next }] });
            }}
          />
          {set.isError ? (
            <Text size="xs" c="red" role="alert">
              {`Couldn't save: ${set.error.message}`}
            </Text>
          ) : null}
          <Group justify="space-between">
            <Button
              variant="default"
              size="xs"
              disabled={isEmptyCell(own) || set.isPending}
              onClick={() => {
                set.mutate({
                  cells: [
                    {
                      rigor: cell.rigor,
                      role: cell.role,
                      personaId: null,
                      model: null,
                      effort: null,
                    },
                  ],
                });
              }}
            >
              Reset
            </Button>
            <Button
              size="xs"
              onClick={() => {
                setOpened(false);
              }}
            >
              Done
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
