import {
  KindInput,
  RIGORS,
  StepRole,
  type CellSetting,
  type KindDto,
  type Rigor,
} from '@10db/contracts';
import {
  Accordion,
  Button,
  Checkbox,
  Drawer,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { ConfirmModal } from '../../shell/confirm-modal';
import { useCreateKind, useDeleteKind, usePatchKind } from '../../daemon/kind-queries';
import { usePersonas } from '../../daemon/persona-queries';
import { settingSummary } from './model-setting-options';
import { CellFields } from './playbook-cell-fields';
import { isEmptyCell } from './playbook-edits';
import { rigorLabel } from './rigor-labels';
import { ROLES } from './role-labels';

const NO_MINIMUM = 'none';
const NO_OVERRIDE: CellSetting = { personaId: null, model: null, effort: null };

const NO_OVERRIDE_LABELS = {
  persona: 'No override',
  model: 'No override',
  effort: 'No override',
  minimumPlaceholder: 'No minimum',
} as const;

type Overrides = Partial<Record<StepRole, CellSetting>>;

interface Draft {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly minimumRigor: Rigor | null;
  readonly alwaysReviewed: boolean;
  readonly failsAtLimit: boolean;
  readonly ownCopy: boolean;
  readonly toInbox: boolean;
  readonly addsSteps: readonly StepRole[];
  readonly overrides: Overrides;
}

const EMPTY_DRAFT: Draft = {
  key: '',
  label: '',
  description: '',
  minimumRigor: null,
  alwaysReviewed: false,
  failsAtLimit: false,
  ownCopy: false,
  toInbox: false,
  addsSteps: [],
  overrides: {},
};

const draftOf = (kind: KindDto | null): Draft => (kind === null ? EMPTY_DRAFT : { ...kind });

const isRigor = (value: string): value is Rigor => RIGORS.some((r) => r === value);

/** The overrides a kind stores: a role with no field set has none. */
function storedOverrides(overrides: Overrides): Overrides {
  const kept: Overrides = {};
  for (const { role } of ROLES) {
    const cell = overrides[role];
    if (cell !== undefined && !isEmptyCell(cell)) kept[role] = cell;
  }
  return kept;
}

const SWITCHES: readonly {
  readonly field: 'alwaysReviewed' | 'failsAtLimit' | 'ownCopy' | 'toInbox';
  readonly label: string;
  readonly about: string;
}[] = [
  { field: 'alwaysReviewed', label: 'Always reviewed', about: 'The review step is never skipped.' },
  {
    field: 'failsAtLimit',
    label: 'Fails at the round limit',
    about: 'A send-back at the round limit fails the task instead of shipping it.',
  },
  {
    field: 'ownCopy',
    label: 'Works in its own copy',
    about: 'Placement puts the task in its own copy of the project.',
  },
  {
    field: 'toInbox',
    label: 'Proposals go to the Inbox',
    about: 'A lane’s proposal of this kind waits in the Inbox, not the Icebox.',
  },
];

/**
 * A kind to read, change or add. The key names the kind to tasks and agents, so it is typed once when the kind is
 * added and read-only after. Save sends every other field; Delete removes the kind after a confirmation.
 */
export function KindDrawer({
  kind,
  opened,
  onClose,
}: {
  /** The kind to edit, or null to add one. */
  readonly kind: KindDto | null;
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(kind));
  const [confirming, setConfirming] = useState(false);
  const personas = usePersonas().data ?? [];
  const create = useCreateKind();
  const patch = usePatchKind();
  const remove = useDeleteKind();
  const change = (over: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...over }));
  };
  const keyOk = kind !== null || KindInput.shape.key.safeParse(draft.key).success;
  const valid = keyOk && draft.label.trim() !== '';
  const saving = create.isPending || patch.isPending;
  const error = (create.error ?? patch.error ?? remove.error)?.message ?? null;
  const fields = () => ({
    label: draft.label,
    description: draft.description,
    minimumRigor: draft.minimumRigor,
    alwaysReviewed: draft.alwaysReviewed,
    failsAtLimit: draft.failsAtLimit,
    ownCopy: draft.ownCopy,
    toInbox: draft.toInbox,
    addsSteps: [...draft.addsSteps],
    overrides: storedOverrides(draft.overrides),
  });
  const save = () => {
    if (kind === null) {
      create.mutate({ key: draft.key, ...fields() }, { onSuccess: onClose });
    } else patch.mutate({ id: kind.id, patch: fields() }, { onSuccess: onClose });
  };
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="lg"
      title={kind === null ? 'Add Kind' : kind.label}
    >
      <Stack gap="md">
        <TextInput
          label="Key"
          description={
            kind === null
              ? 'Lowercase words joined by hyphens. Tasks and agents name the kind by it, and it cannot change later.'
              : 'Tasks and agents name the kind by its key, so it cannot change.'
          }
          readOnly={kind !== null}
          value={draft.key}
          error={
            kind === null && draft.key !== '' && !keyOk
              ? 'Use lowercase words joined by hyphens'
              : null
          }
          onChange={(e) => {
            change({ key: e.currentTarget.value });
          }}
        />
        <TextInput
          label="Label"
          value={draft.label}
          onChange={(e) => {
            change({ label: e.currentTarget.value });
          }}
        />
        <Textarea
          label="Description"
          description="One line the judge reads to decide whether a task is this kind."
          autosize
          minRows={2}
          maxLength={300}
          value={draft.description}
          onChange={(e) => {
            change({ description: e.currentTarget.value });
          }}
        />
        <Select
          label="Minimum rigor"
          description="A task of this kind never runs below it."
          allowDeselect={false}
          data={[
            { value: NO_MINIMUM, label: 'None' },
            ...RIGORS.map((r) => ({ value: r, label: rigorLabel(r) })),
          ]}
          value={draft.minimumRigor ?? NO_MINIMUM}
          onChange={(value) => {
            if (value !== null) change({ minimumRigor: isRigor(value) ? value : null });
          }}
        />
        <Stack gap="xs">
          {SWITCHES.map(({ field, label, about }) => (
            <Switch
              key={field}
              label={label}
              description={about}
              checked={draft[field]}
              onChange={(e) => {
                change({ [field]: e.currentTarget.checked });
              }}
            />
          ))}
        </Stack>
        <Checkbox.Group
          label="Adds steps"
          description="Steps this kind runs even when its rigor does not."
          value={[...draft.addsSteps]}
          onChange={(values) => {
            change({ addsSteps: ROLES.map((r) => r.role).filter((r) => values.includes(r)) });
          }}
        >
          <Group gap="md" mt="xs">
            {ROLES.filter((r) => r.role !== StepRole.Implement).map(({ role, label }) => (
              <Checkbox key={role} value={role} label={label} />
            ))}
          </Group>
        </Checkbox.Group>
        <Stack gap="xs">
          <Text size="sm" fw={500}>
            Overrides
          </Text>
          <Text size="xs" c="dimmed">
            A step of this kind takes the stronger of its cell and its override, and never runs
            weaker than its cell.
          </Text>
          <Accordion variant="separated" multiple>
            {ROLES.map(({ role, label }) => {
              const cell = draft.overrides[role] ?? NO_OVERRIDE;
              return (
                <Accordion.Item key={role} value={role}>
                  <Accordion.Control aria-label={`${label} override`}>
                    <Group justify="space-between" wrap="nowrap" pr="sm">
                      <Text size="sm">{label}</Text>
                      <Text size="xs" c="dimmed">
                        {isEmptyCell(cell)
                          ? 'None'
                          : [cell.model === null ? null : settingSummary(cell.model), cell.effort]
                              .filter((part) => part !== null)
                              .join(' · ') || 'Persona only'}
                      </Text>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="sm">
                      <CellFields
                        role={role}
                        value={cell}
                        personas={personas}
                        accountIds={null}
                        none={NO_OVERRIDE_LABELS}
                        onChange={(next) => {
                          change({ overrides: { ...draft.overrides, [role]: next } });
                        }}
                      />
                      <Group justify="flex-end">
                        <Button
                          size="xs"
                          variant="default"
                          disabled={isEmptyCell(cell)}
                          onClick={() => {
                            change({ overrides: { ...draft.overrides, [role]: NO_OVERRIDE } });
                          }}
                        >
                          Clear Override
                        </Button>
                      </Group>
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
        </Stack>
        {error === null ? null : (
          <Text size="sm" c="red" role="alert">
            {error}
          </Text>
        )}
        <Group justify="space-between">
          {kind === null ? (
            <span />
          ) : (
            <Button
              variant="default"
              color="red"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Delete Kind
            </Button>
          )}
          <Group gap="sm">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!valid} loading={saving} onClick={save}>
              {kind === null ? 'Add Kind' : 'Save'}
            </Button>
          </Group>
        </Group>
      </Stack>
      <ConfirmModal
        opened={confirming}
        title="Delete Kind"
        confirmLabel="Delete Kind"
        destructive
        loading={remove.isPending}
        error={remove.error?.message ?? null}
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          if (kind !== null)
            remove.mutate(kind.id, {
              onSuccess: () => {
                setConfirming(false);
                onClose();
              },
            });
        }}
      >
        {`Delete ${kind?.label ?? 'this kind'}? Tasks that have it keep the key, but it adds no minimum, switches or overrides once it is gone.`}
      </ConfirmModal>
    </Drawer>
  );
}
