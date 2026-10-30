import {
  isTerminal,
  NEW_TASK_NO_CRITERIA,
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
import {
  useCloseTask,
  useHoldTask,
  usePatchTask,
  useRemoveTask,
  useRetryWorkstream,
  useRunNext,
  useStartTask,
} from '../../daemon/queries';
import { StateBadge } from '../factory/state-badge';
import { canClose, canRetry } from '../factory/workstream-state';
import { ReviewRoundsList } from '../review/review-rounds-list';
import { criteriaLines } from './areas-text';
import { closeNote } from './batch/close-note';
import { BatchPanel } from './batch-panel';
import { FlowSelect } from './flow-select';
import {
  draftOf,
  landingChanged,
  landingFromDraft,
  landingLine,
  type LandingDraft,
} from './landing-draft';
import { LandingField } from './landing-field';
import { ordinal, runNextNote } from './queue-place';
import { canRunNext } from './run-next';
import { RISK_LABEL } from './risk-labels';
import { holdOption, isHeld, type HoldOption } from './task-hold';

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
  /** A queued task's place in line, counting from 1. */
  readonly place?: number;
  /**
   * The project's base branch, when it delivers by pull request: the drawer then says where the
   * task lands, and lets the builder change it until the task has run.
   */
  readonly pullRequestBase?: string;
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
  place,
  pullRequestBase,
  onClose,
}: TaskDrawerProps) {
  const patch = usePatchTask();
  const [landing, setLanding] = useState<LandingDraft>(() => draftOf(task.landing));
  const [landingError, setLandingError] = useState<string | null>(null);
  // Once the task has run its batch decides where its pull request lands.
  const landingEditable = task.workstreamId === null;
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
    risks.some((r) => !task.riskTags.includes(r)) ||
    (pullRequestBase !== undefined && landingEditable && landingChanged(task.landing, landing));

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
      setError(NEW_TASK_NO_CRITERIA);
      return;
    }
    const changesLanding =
      pullRequestBase !== undefined && landingEditable && landingChanged(task.landing, landing);
    const where = landingFromDraft(landing);
    if (changesLanding && !where.ok) {
      setLandingError(where.error);
      return;
    }
    setError(null);
    setLandingError(null);
    patch.mutate(
      {
        taskId: task.id,
        patch: {
          title: title.trim(),
          description: description.trim(),
          acceptanceCriteria: lines,
          flowId,
          riskTags: risks,
          ...(changesLanding && where.ok ? { landing: where.landing } : {}),
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
        {workstream ? (
          <WorkstreamLine
            task={task}
            workstream={workstream}
            holdable={holdOption(task, workstream)}
            batch={batch}
            place={place}
            onClosed={onClose}
          />
        ) : null}
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
        {pullRequestBase === undefined ? null : landingEditable ? (
          <LandingField
            baseBranch={pullRequestBase}
            value={landing}
            error={landingError}
            onChange={(draft) => {
              setLanding(draft);
              setLandingError(null);
            }}
          />
        ) : (
          <Stack gap={2}>
            <Text size="sm" fw={500}>
              Where it lands
            </Text>
            <Text size="sm">{landingLine(task, batch, pullRequestBase)}</Text>
          </Stack>
        )}
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

/**
 * The workstream's state: for a failed one why, a way to retry it and a way to close its task; for
 * a queued one its place in line, Run Next and Hold; for a held one Start and Remove.
 */
function WorkstreamLine({
  task,
  workstream,
  holdable,
  batch,
  place,
  onClosed,
}: {
  readonly task: TaskDto;
  readonly workstream: WorkstreamDto;
  /** Hold for a started task that has not run, or why it can't be held; null when there is nothing to hold. */
  readonly holdable: HoldOption | null;
  readonly batch: BatchDto | undefined;
  readonly place: number | undefined;
  readonly onClosed: () => void;
}) {
  const taskId = task.id;
  const retry = useRetryWorkstream();
  const [note, setNote] = useState('');
  const closeTask = useCloseTask();
  const runNext = useRunNext();
  const hold = useHoldTask();
  const start = useStartTask();
  const remove = useRemoveTask();
  const failed = canRetry(workstream.state);
  // A parked task never takes a lane, so putting it first would change nothing.
  const queued = canRunNext(task, workstream.state);
  const held = isHeld(workstream);
  if (isTerminal(workstream.state) && !failed) {
    return null;
  }
  const busy = hold.isPending || start.isPending || remove.isPending;
  const refusal = [hold, start, remove].find((m) => m.error)?.error?.message ?? null;
  return (
    <Stack gap={4}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <StateBadge state={workstream.state} />
          {queued && place !== undefined ? (
            <Text size="xs" c="dimmed">
              {place === 1 ? 'next in line' : `${ordinal(place)} in line`}
            </Text>
          ) : null}
        </Group>
        <Group gap="xs" wrap="nowrap">
          {queued ? (
            <Button
              size="xs"
              variant="default"
              loading={runNext.isPending}
              onClick={() => {
                runNext.mutate(taskId);
              }}
            >
              Run Next
            </Button>
          ) : null}
          {holdable ? (
            <Button
              size="xs"
              variant="default"
              disabled={holdable.kind === 'refused' || busy}
              loading={hold.isPending}
              onClick={() => {
                hold.mutate(taskId);
              }}
            >
              Hold
            </Button>
          ) : null}
          {held ? (
            <>
              <Button
                size="xs"
                variant="default"
                disabled={busy}
                loading={start.isPending}
                onClick={() => {
                  start.mutate(taskId);
                }}
              >
                Start
              </Button>
              <Button
                size="xs"
                variant="default"
                color="red"
                disabled={busy}
                loading={remove.isPending}
                onClick={() => {
                  remove.mutate(taskId, { onSuccess: onClosed });
                }}
              >
                Remove
              </Button>
            </>
          ) : null}
          {failed ? (
            <Button
              size="xs"
              variant="default"
              loading={retry.isPending}
              onClick={() => {
                closeTask.reset();
                const text = note.trim();
                retry.mutate(
                  text === '' ? { id: workstream.id } : { id: workstream.id, note: text },
                );
              }}
            >
              Retry
            </Button>
          ) : null}
          {canClose(workstream.state) ? (
            <Button
              size="xs"
              variant="default"
              loading={closeTask.isPending}
              onClick={() => {
                retry.reset();
                closeTask.mutate(taskId, { onSuccess: onClosed });
              }}
            >
              Close task
            </Button>
          ) : null}
        </Group>
      </Group>
      {holdable?.kind === 'refused' ? (
        <Text size="xs" c="dimmed">
          {holdable.reason}
        </Text>
      ) : null}
      {held ? (
        <Text size="xs" c="dimmed">
          Held: it keeps its worktree and takes no lane. Start it to queue it again, or Remove it to
          delete its worktree and branch.
        </Text>
      ) : null}
      {refusal !== null ? (
        <Text size="xs" c="red" role="alert">
          {refusal}
        </Text>
      ) : null}
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
      {canClose(workstream.state) ? (
        <Text size="xs" c="dimmed">
          {closeNote(batch)}
        </Text>
      ) : null}
      {runNext.data ? (
        <Text size="xs" c="dimmed">
          {runNextNote(task.title, runNext.data.waitingOn)}
        </Text>
      ) : null}
      {runNext.error ? (
        <Text
          size="xs"
          c="red"
          role="alert"
        >{`Couldn't run it next: ${runNext.error.message}`}</Text>
      ) : null}
      {retry.error ? (
        <Text size="xs" c="red" role="alert">{`Couldn't retry: ${retry.error.message}`}</Text>
      ) : null}
      {closeTask.error ? (
        <Text size="xs" c="red" role="alert">{`Couldn't close: ${closeTask.error.message}`}</Text>
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
