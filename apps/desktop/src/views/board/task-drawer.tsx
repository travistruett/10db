import {
  isTerminal,
  SYSTEM_COLUMN_LABEL,
  RiskTag,
  WorkspaceMode,
  type BatchDto,
  type FlowId,
  type TaskDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  Badge,
  Button,
  Drawer,
  Group,
  Modal,
  MultiSelect,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { usePatchTask, useRetryWorkstream } from '../../daemon/queries';
import { StateBadge } from '../factory/state-badge';
import { canRetry } from '../factory/workstream-state';
import { ReviewRoundsList } from '../review/review-rounds-list';
import { criteriaLines } from './areas-text';
import { BatchPanel } from './batch-panel';
import { FlowSelect } from './flow-select';
import { RISK_LABEL } from './risk-labels';

const RISKS: readonly RiskTag[] = Object.values(RiskTag);
const isRisk = (value: string): value is RiskTag => RISKS.some((r) => r === value);

export interface TaskDrawerProps {
  readonly task: TaskDto;
  /** Where the card sits: a human column's name, or the state column it follows. */
  readonly columnName: string;
  readonly peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title'>>;
  /** The task's workstream, when it has one; its state shows above the fields. */
  readonly workstream?: WorkstreamDto;
  /** The batch the workstream ships in; its branch, pull request and actions show in the drawer. */
  readonly batch?: BatchDto;
  /** Every workstream, so the batch knows its members; used for Ship anyway and fix tasks. */
  readonly workstreams?: readonly WorkstreamDto[];
  readonly workspaceMode?: WorkspaceMode;
  /** The project's gate command, named beside a failed gate's exit code. */
  readonly gateCommand?: string | null;
  readonly onClose: () => void;
}

/** A task's details: what it is and how it runs, editable where the daemon allows. */
export function TaskDrawer({
  task,
  columnName,
  peers,
  workstream,
  batch,
  workstreams = [],
  workspaceMode = WorkspaceMode.Shared,
  gateCommand = null,
  onClose,
}: TaskDrawerProps) {
  const patch = usePatchTask();
  const initialCriteria = task.acceptanceCriteria.join('\n');
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [criteria, setCriteria] = useState(initialCriteria);
  const [flowId, setFlowId] = useState<FlowId | null>(task.flowId);
  const [risks, setRisks] = useState<RiskTag[]>([...task.riskTags]);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const waitsOn = task.dependsOn.flatMap((id) => {
    const peer = peers.get(id);
    return peer ? [peer.title] : [];
  });
  const live = workstream !== undefined && !isTerminal(workstream.state);

  const dirty =
    title !== task.title ||
    description !== task.description ||
    criteria !== initialCriteria ||
    flowId !== task.flowId ||
    risks.length !== task.riskTags.length ||
    risks.some((r) => !task.riskTags.includes(r));

  // Every way out (close button, Escape, outside click, Cancel) comes through here.
  const requestClose = () => {
    if (dirty) {
      setConfirmingDiscard(true);
    } else {
      onClose();
    }
  };

  const save = () => {
    const lines = criteriaLines(criteria);
    if (title.trim() === '') {
      setError('Give the task a title');
      return;
    }
    if (lines.length === 0) {
      setError('Add at least one acceptance criterion');
      return;
    }
    setError(null);
    patch.mutate(
      {
        taskId: task.id,
        patch: {
          title: title.trim(),
          description: description.trim(),
          acceptanceCriteria: lines,
          flowId,
          riskTags: risks,
        },
      },
      { onSuccess: onClose },
    );
  };
  const message =
    error ??
    (patch.error
      ? `Couldn't save: ${patch.error.message}`
      : live
        ? "Changes apply from the task's next session."
        : null);

  return (
    <Drawer
      opened
      onClose={requestClose}
      closeOnEscape={!confirmingDiscard}
      position="right"
      size={520}
      title="Task"
      padding="lg"
    >
      <Stack gap="lg">
        {workstream ? <WorkstreamLine workstream={workstream} /> : null}
        {workstream ? <ReviewRoundsList steps={workstream.steps} /> : null}
        {batch ? (
          <BatchPanel
            batch={batch}
            workstreams={workstreams}
            workspaceMode={workspaceMode}
            gateCommand={gateCommand}
          />
        ) : null}
        <TextInput
          aria-label="Title"
          size="md"
          fw={600}
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value);
          }}
        />
        <Group gap={6}>
          <Badge size="sm" variant="light" color="gray" tt="none" fw={500}>
            {columnName}
          </Badge>
          {task.areas.map((area) => (
            <Badge key={area} size="sm" variant="light" color="gray" tt="none" fw={500}>
              {area}
            </Badge>
          ))}
          {waitsOn.length > 0 ? (
            <Text size="xs" c="dimmed">{`Waits on ${waitsOn.join(', ')}`}</Text>
          ) : null}
        </Group>
        <Textarea
          label="Description"
          autosize
          minRows={2}
          maxRows={12}
          value={description}
          onChange={(e) => {
            setDescription(e.currentTarget.value);
          }}
        />
        <Textarea
          label="Acceptance criteria"
          description="One per line. A reviewer agent checks each one and asks for a test that proves it."
          autosize
          minRows={2}
          maxRows={16}
          value={criteria}
          onChange={(e) => {
            setCriteria(e.currentTarget.value);
          }}
        />
        <FlowSelect
          label="Flow"
          description="The steps this task goes through."
          placeholder="Project default"
          clearable
          value={flowId}
          onChange={setFlowId}
        />
        <MultiSelect
          label="Risks"
          description="Security, sign-in or migration work gets a review of the plan before any code."
          data={RISKS.map((r) => ({ value: r, label: RISK_LABEL[r] }))}
          value={risks}
          onChange={(values) => {
            setRisks(values.filter(isRisk));
          }}
        />
      </Stack>
      {/* Pinned to the drawer's bottom edge, so Save never scrolls away. */}
      <Group
        justify="space-between"
        wrap="nowrap"
        pos="sticky"
        bottom={0}
        mt="xl"
        mx="calc(var(--mantine-spacing-lg) * -1)"
        mb="calc(var(--mantine-spacing-lg) * -1)"
        px="lg"
        py="md"
        bg="var(--mantine-color-body)"
        style={{
          borderTop: '1px solid var(--mantine-color-default-border)',
          zIndex: 'var(--mantine-z-index-app)',
        }}
      >
        <Text
          size="sm"
          c={error !== null || patch.error ? 'red' : 'dimmed'}
          role="alert"
          lineClamp={2}
        >
          {message ?? ''}
        </Text>
        <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
          <Button variant="default" onClick={requestClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={patch.isPending}>
            Save Changes
          </Button>
        </Group>
      </Group>
      <Modal
        opened={confirmingDiscard}
        onClose={() => {
          setConfirmingDiscard(false);
        }}
        title="Discard your changes to this task?"
        centered
        size="sm"
      >
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>
            Discard
          </Button>
          <Button
            data-autofocus
            onClick={() => {
              setConfirmingDiscard(false);
            }}
          >
            Keep Editing
          </Button>
        </Group>
      </Modal>
    </Drawer>
  );
}

/** The workstream's state, and for a failed one why and a way to retry it. */
function WorkstreamLine({ workstream }: { readonly workstream: WorkstreamDto }) {
  const retry = useRetryWorkstream();
  const [note, setNote] = useState('');
  const failed = canRetry(workstream.state);
  if (isTerminal(workstream.state) && !failed) {
    return null;
  }
  return (
    <Stack gap={4}>
      <Group justify="space-between" wrap="nowrap">
        <StateBadge state={workstream.state} />
        {failed ? (
          <Button
            size="xs"
            variant="default"
            loading={retry.isPending}
            onClick={() => {
              const text = note.trim();
              retry.mutate(text === '' ? { id: workstream.id } : { id: workstream.id, note: text });
            }}
          >
            Retry
          </Button>
        ) : null}
      </Group>
      {failed && workstream.failureReason !== null ? (
        <Text size="xs" c="dimmed">
          {workstream.failureReason}
        </Text>
      ) : null}
      {failed ? (
        <Textarea
          label="Note for the next session (optional)"
          description="The session the retry starts gets this note, and the review’s findings too when a review sent the work back."
          size="xs"
          autosize
          minRows={1}
          maxRows={6}
          maxLength={4000}
          value={note}
          onChange={(e) => {
            setNote(e.currentTarget.value);
          }}
        />
      ) : null}
      {retry.error ? (
        <Text size="xs" c="red" role="alert">{`Couldn't retry: ${retry.error.message}`}</Text>
      ) : null}
    </Stack>
  );
}

/** A card's column for the drawer: its human column's name, or the state column it follows. */
export function columnNameOf(
  task: Pick<TaskDto, 'boardColumnId' | 'boardStatus'>,
  humanColumns: ReadonlyMap<string, string>,
): string {
  return task.boardColumnId === null
    ? SYSTEM_COLUMN_LABEL[task.boardStatus]
    : (humanColumns.get(task.boardColumnId) ?? 'Parked');
}
