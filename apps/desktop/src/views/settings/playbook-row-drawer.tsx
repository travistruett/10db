import { FixBy, type PlaybookRowDto, type PlaybookSource, type ProjectId } from '@10db/contracts';
import {
  Button,
  Checkbox,
  Drawer,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import type { ReactNode } from 'react';
import { useSetPlaybook } from '../../daemon/playbook-queries';
import { FIX_BY_LABELS, hasReviewingStep, scopeSource, toggleStep } from './playbook-edits';
import { RIGOR_LABELS } from './rigor-labels';
import { ROLES } from './role-labels';

const SOURCE_LABELS: Readonly<Record<PlaybookSource, string>> = {
  default: 'default',
  global: 'global',
  project: 'this project',
};

const ROUNDS = ['0', '1', '2', '3'];
const FIX_BY_OPTIONS = Object.values(FixBy).map((value) => ({
  value,
  label: FIX_BY_LABELS[value],
}));
const NO_REVIEW = 'Only for a review the change forces';

/** One field of a row's process: where its value comes from and the button that hands it back to the scope above. */
function ProcessField({
  title,
  name,
  source,
  scope,
  busy,
  onReset,
  note,
  children,
}: {
  readonly title: string;
  /** The field's name inside the Reset button's accessible name. */
  readonly name: string;
  readonly source: PlaybookSource;
  readonly scope: PlaybookSource;
  readonly busy: boolean;
  readonly onReset: () => void;
  readonly note?: string | null;
  readonly children: ReactNode;
}) {
  const inProject = scope === 'project';
  return (
    <Stack gap={6}>
      <Group justify="space-between" wrap="nowrap" align="baseline">
        <Text size="sm" fw={500}>
          {title}
        </Text>
        <Group gap="xs" wrap="nowrap">
          <Text size="xs" c="dimmed">
            {SOURCE_LABELS[source]}
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            aria-label={`${inProject ? 'Use global' : 'Reset'}: ${name}`}
            disabled={source !== scope || busy}
            onClick={onReset}
          >
            {inProject ? 'Use global' : 'Reset'}
          </Button>
        </Group>
      </Group>
      {children}
      {note === null || note === undefined ? null : (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      )}
    </Stack>
  );
}

/**
 * A rigor's process: the steps it runs, how many rounds a reviewer may send work back, what fixes a send-back,
 * and whether the builder approves the plan. A change saves at once, and only the field changed is sent, in this
 * scope; a field's Reset (Use global, in a project) hands only that field back to the scope above.
 */
export function PlaybookRowDrawer({
  row,
  projectId,
  opened,
  onClose,
}: {
  readonly row: PlaybookRowDto | null;
  readonly projectId: ProjectId | null;
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  const set = useSetPlaybook(projectId);
  const scope = scopeSource(projectId);
  const steps = row?.steps.value ?? [];
  const reviews = hasReviewingStep(steps);
  const hasPlan = steps.includes('plan');
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      closeButtonProps={{ 'aria-label': 'Close' }}
      position="right"
      size="md"
      title={row === null ? '' : `${RIGOR_LABELS[row.rigor].label}: process`}
    >
      {row === null ? null : (
        <Stack gap="lg">
          <Text size="sm" c="dimmed">
            {RIGOR_LABELS[row.rigor].about} Build always runs, and a plan review needs a plan.
          </Text>
          <ProcessField
            title="Steps"
            name="steps"
            source={row.steps.source}
            scope={scope}
            busy={set.isPending}
            onReset={() => {
              set.mutate({ rows: [{ rigor: row.rigor, steps: null }] });
            }}
          >
            <Stack gap="xs">
              {ROLES.map(({ role, label, about }) => (
                <Checkbox
                  key={role}
                  label={label}
                  description={about}
                  checked={steps.includes(role)}
                  disabled={role === 'implement' || set.isPending}
                  onChange={(e) => {
                    set.mutate({
                      rows: [
                        {
                          rigor: row.rigor,
                          steps: toggleStep(steps, role, e.currentTarget.checked),
                        },
                      ],
                    });
                  }}
                />
              ))}
            </Stack>
          </ProcessField>
          <ProcessField
            title="Review rounds"
            name="review rounds"
            source={row.reviewRounds.source}
            scope={scope}
            busy={set.isPending}
            note={reviews ? null : NO_REVIEW}
            onReset={() => {
              set.mutate({ rows: [{ rigor: row.rigor, reviewRounds: null }] });
            }}
          >
            <SegmentedControl
              aria-label="Review rounds"
              data={ROUNDS}
              value={String(row.reviewRounds.value)}
              disabled={set.isPending}
              onChange={(value) => {
                set.mutate({ rows: [{ rigor: row.rigor, reviewRounds: Number(value) }] });
              }}
            />
          </ProcessField>
          <ProcessField
            title="A send-back is fixed by"
            name="send-back fix"
            source={row.fixBy.source}
            scope={scope}
            busy={set.isPending}
            note={reviews ? null : NO_REVIEW}
            onReset={() => {
              set.mutate({ rows: [{ rigor: row.rigor, fixBy: null }] });
            }}
          >
            <Select
              aria-label="A send-back is fixed by"
              data={FIX_BY_OPTIONS}
              value={row.fixBy.value}
              allowDeselect={false}
              disabled={set.isPending}
              onChange={(value) => {
                const picked = FIX_BY_OPTIONS.find((o) => o.value === value);
                if (picked) set.mutate({ rows: [{ rigor: row.rigor, fixBy: picked.value }] });
              }}
            />
          </ProcessField>
          <ProcessField
            title="Plan approval"
            name="plan approval"
            source={row.approvesPlan.source}
            scope={scope}
            busy={set.isPending}
            note={hasPlan ? null : 'Needs a Plan step'}
            onReset={() => {
              set.mutate({ rows: [{ rigor: row.rigor, approvesPlan: null }] });
            }}
          >
            <Switch
              label="The builder approves the plan"
              description="Build starts when you approve it in the Inbox."
              checked={row.approvesPlan.value && hasPlan}
              disabled={!hasPlan || set.isPending}
              onChange={(e) => {
                set.mutate({ rows: [{ rigor: row.rigor, approvesPlan: e.currentTarget.checked }] });
              }}
            />
          </ProcessField>
          {set.isError ? (
            <Text size="xs" c="red" role="alert">
              {`Couldn't save: ${set.error.message}`}
            </Text>
          ) : null}
          <Group justify="flex-end">
            <Button onClick={onClose}>Done</Button>
          </Group>
        </Stack>
      )}
    </Drawer>
  );
}
