import {
  isTerminal,
  NEW_TASK_NO_AREAS,
  NEW_TASK_NO_CRITERIA,
  PASS_FOLDER_WAIT_NOTICE_KEY,
  reviewRounds,
  SYSTEM_COLUMN_LABEL,
  RiskTag,
  TaskStatus,
  type AccountId,
  type BatchDto,
  type FlowId,
  type ModelSetting,
  type Notice,
  type ShapeId,
  type TaskDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Drawer,
  Group,
  List,
  Modal,
  MultiSelect,
  Stack,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useState } from 'react';
import { OpenConversation } from '../shape/open-conversation';
import { PlanContextDisclosure } from './plan-context-disclosure';
import { TaskSizeLine } from '../shape/task-size-line';
import {
  useCloseTask,
  useHoldTask,
  usePatchTask,
  useRemoveTask,
  useReopenTask,
  useRetryWorkstream,
  useRunNext,
  useStartTask,
  useStartTaskOver,
} from '../../daemon/queries';
import { RelativeTime } from '../factory/relative-time';
import { StateBadge } from '../factory/state-badge';
import { canRetry } from '../factory/workstream-state';
import { ReviewRoundsList, roundReviewer, roundVerdict } from '../review/review-rounds-list';
import { criteriaLines } from './areas-text';
import { closeNote } from './batch/close-note';
import { CopyTaskId } from './copy-task-id';
import { BatchPanel } from './batch-panel';
import { ciLine, ciStatus } from './ci-line';
import { FlowSelect } from './flow-select';
import {
  draftOf,
  landingChanged,
  landingFromDraft,
  landingLine,
  type LandingDraft,
} from './landing-draft';
import { sameSetting } from '../settings/model-setting-options';
import { ModelSettingSelect } from '../settings/model-setting-select';
import { KeptWork } from './kept-work';
import { TaskPictures } from './task-pictures';
import { LandingField } from './landing-field';
import { placementOpen } from './placement';
import { PlacementBadge } from './placement-badge';
import { PlacementChoice } from './placement-choice';
import { ExternalLink, PullRequestLink } from './pull-request-link';
import { ordinal, runNextNote } from './queue-place';
import { canRunNext } from './run-next';
import { QuestionRoutesLine } from './question-routes-line';
import { RISK_LABEL } from './risk-labels';
import { canCancelRun } from './task-cancel';
import { holdOption, isHeld, type HoldOption } from './task-hold';
import { HeadlineField, WhyField } from './task-words-fields';
import {
  canCloseRun,
  canRetryRun,
  canStartOver,
  failureLine,
  pullRequestClosed,
  shippedAnywayAndClosed,
  shippedAtLimitLine,
  taskHistory,
  taskNotices,
} from './task-state';

type DrawerTab = 'overview' | 'reviews' | 'edit';

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
  /** Every batch of the project: a CI fix batch finds the root that holds the required checks. */
  readonly batches?: readonly BatchDto[];
  /** Every workstream, so the batch knows its members; used for Ship anyway and fix tasks. */
  readonly workstreams?: readonly WorkstreamDto[];
  /**
   * Whether the project delivers by pull request, the only delivery where a task can run in a
   * separate copy; the placement control shows only then, and only while the placement is open.
   */
  readonly placementEditable?: boolean;
  /** The project's gate command, named beside a failed gate's exit code. */
  readonly gateCommand?: string | null;
  /** The project's account, whose models the task's own model setting offers; the field shows only with it. */
  readonly accountId?: AccountId;
  /** Starts the task afresh: offered when a failed run shipped anyway and its pull request closed. */
  readonly onStart?: () => void;
  /** Cancels the task's run once the builder confirms; the board holds the confirm. */
  readonly onCancelRun?: (workstream: WorkstreamDto) => void;
  /** A queued task's place in line, counting from 1. */
  readonly place?: number;
  /**
   * The project's base branch, when it delivers by pull request: the drawer then says where the
   * task lands, and lets the builder change it until the task has run.
   */
  readonly pullRequestBase?: string;
  /**
   * The project's area names. With them, a task that has never started can have its areas changed
   * here; without them, or once it has started, they show as they are.
   */
  readonly areaNames?: readonly string[];
  /**
   * Opens the conversation that made the task (Shape spec §12). With it, the drawer asks whether one
   * did and offers Open conversation only then; without it (a drawer outside the router), nothing.
   */
  readonly onOpenConversation?: (shapeId: ShapeId) => void;
  /** Opens the Workbench, from a task waiting for the pass that holds Your folder. */
  readonly onOpenWorkbench?: () => void;
  readonly onClose: () => void;
}

/** A task's details: what it is and how it runs, editable where the daemon allows. */
export function TaskDrawer({
  task,
  columnName,
  peers,
  workstream,
  batch,
  batches = [],
  workstreams = [],
  placementEditable = false,
  gateCommand = null,
  accountId,
  onStart,
  onCancelRun,
  place,
  pullRequestBase,
  areaNames,
  onOpenConversation,
  onOpenWorkbench,
  onClose,
}: TaskDrawerProps) {
  const patch = usePatchTask();
  // The placement is saved on its own the moment it is chosen, so its refusal stays beside it.
  const placementPatch = usePatchTask();
  const placementIsOpen = placementOpen(task, workstream?.state);
  const [landing, setLanding] = useState<LandingDraft>(() => draftOf(task.landing));
  const [landingError, setLandingError] = useState<string | null>(null);
  // Once the task has run its batch decides where its pull request lands.
  const landingEditable = task.workstreamId === null;
  const initialCriteria = task.acceptanceCriteria.join('\n');
  const [title, setTitle] = useState(task.title);
  const [headline, setHeadline] = useState(task.headline);
  const [why, setWhy] = useState(task.why);
  const wordsChanged = headline.trim() !== task.headline || why.trim() !== task.why;
  const [description, setDescription] = useState(task.description);
  const [criteria, setCriteria] = useState(initialCriteria);
  const [flowId, setFlowId] = useState<FlowId | null>(task.flowId);
  const [risks, setRisks] = useState<RiskTag[]>([...task.riskTags]);
  const [modelSetting, setModelSetting] = useState<ModelSetting | null>(task.modelSetting);
  const modelSettingChanged = !sameSetting(modelSetting, task.modelSetting);
  // Areas are the claims the lane takes when it starts, so they change only before then.
  const areasEditable =
    areaNames !== undefined && task.workstreamId === null && task.status === TaskStatus.Open;
  const [areas, setAreas] = useState<string[]>([...task.areas]);
  const areasChanged =
    areasEditable &&
    (areas.length !== task.areas.length || areas.some((a) => !task.areas.includes(a)));
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const waitsOn = task.dependsOn.flatMap((id) => {
    const peer = peers.get(id);
    return peer ? [peer.title] : [];
  });
  const live = workstream !== undefined && !isTerminal(workstream.state);
  const limitLine = shippedAtLimitLine(workstream);
  // Overview is where a drawer opens; the form and its Save bar are on Edit alone.
  const [tab, setTab] = useState<DrawerTab>('overview');
  // With a headline the header says it and What it promises says the title; without one the title is
  // the header and What it promises is only the criteria, so the title shows once.
  const hasHeadline = task.headline !== '';
  const rounds = reviewRounds(workstream?.steps ?? []);
  const latestRound = rounds[0];

  const dirty =
    title !== task.title ||
    headline !== task.headline ||
    why !== task.why ||
    description !== task.description ||
    criteria !== initialCriteria ||
    flowId !== task.flowId ||
    risks.length !== task.riskTags.length ||
    risks.some((r) => !task.riskTags.includes(r)) ||
    modelSettingChanged ||
    areasChanged ||
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
    if (areasEditable && areas.length === 0) {
      setError(NEW_TASK_NO_AREAS);
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
          ...(wordsChanged ? { headline: headline.trim(), why: why.trim() } : {}),
          ...(areasChanged ? { areas } : {}),
          ...(modelSettingChanged ? { modelSetting } : {}),
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
      // A side panel: the Board stays visible beside it, so it is never wider than half the window.
      size="min(640px, 50vw)"
      title="Task"
      padding="lg"
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      <Stack gap="md">
        <Stack gap={4}>
          <Title order={3} size="h4" fw={600}>
            {hasHeadline ? task.headline : task.title}
          </Title>
          {task.why ? (
            <Text size="sm" c="dimmed">
              {task.why}
            </Text>
          ) : null}
          {hasHeadline ? null : (
            <Anchor
              component="button"
              type="button"
              size="xs"
              c="dimmed"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                setTab('edit');
              }}
            >
              Add a headline
            </Anchor>
          )}
        </Stack>
        <StatusLine
          task={task}
          columnName={columnName}
          workstream={workstream}
          // A pass's page is held and stopped from the Workbench (Take Out), never from here.
          holdable={batch?.passId == null ? holdOption(task, workstream) : null}
          batch={batch}
          batches={batches}
          place={place}
          onClosed={onClose}
          {...(onCancelRun && batch?.passId == null ? { onCancelRun } : {})}
        />
        <TaskNotices
          notices={[...taskNotices(workstream, batch), ...taskHistory(workstream, batch)]}
          {...(onOpenWorkbench ? { onOpenWorkbench } : {})}
        />
        {task.keptWork === true ? <KeptWork taskId={task.id} /> : null}
        {batch && task.status === TaskStatus.Done && pullRequestClosed(batch) ? (
          <ClosedPullRequest taskId={task.id} batch={batch} onClosed={onClose} />
        ) : null}
        {batch && task.status === TaskStatus.Open && shippedAnywayAndClosed(workstream, batch) ? (
          <ClosedPullRequest
            taskId={task.id}
            batch={batch}
            onClosed={onClose}
            {...(onStart ? { onStart } : {})}
          />
        ) : null}
        {limitLine ? (
          <Alert color="orange" variant="light" data-testid="shipped-at-limit">
            {limitLine}
          </Alert>
        ) : null}
        <Tabs
          value={tab}
          onChange={(value) => {
            if (value === 'overview' || value === 'reviews' || value === 'edit') setTab(value);
          }}
          // Only the open tab is drawn. What was typed lives in this component, so it survives a switch.
          keepMounted={false}
        >
          <Tabs.List>
            <Tabs.Tab value="overview">Overview</Tabs.Tab>
            <Tabs.Tab
              value="reviews"
              rightSection={
                rounds.length > 0 ? (
                  <Badge size="xs" circle variant="light" color="gray">
                    {rounds.length}
                  </Badge>
                ) : null
              }
            >
              Reviews
            </Tabs.Tab>
            <Tabs.Tab value="edit">Edit</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="overview" pt="md">
            <Stack gap="lg">
              {hasHeadline || task.acceptanceCriteria.length > 0 ? (
                <Stack gap={4}>
                  <SectionLabel>What it promises</SectionLabel>
                  {/* Without a headline the title is the header above; saying it twice is noise. */}
                  {hasHeadline ? <Text size="sm">{task.title}</Text> : null}
                  {task.acceptanceCriteria.length > 0 ? (
                    <List size="sm" spacing={2}>
                      {task.acceptanceCriteria.map((line, index) => (
                        <List.Item key={`${String(index)}:${line}`}>{line}</List.Item>
                      ))}
                    </List>
                  ) : null}
                </Stack>
              ) : null}
              <QuestionRoutesLine task={task} />
              {waitsOn.length > 0 ? (
                <Stack gap={4} data-testid="waits-on">
                  <SectionLabel>Waits on</SectionLabel>
                  {waitsOn.map((waitTitle, index) => (
                    <Text key={`${String(index)}:${waitTitle}`} size="sm">
                      {waitTitle}
                    </Text>
                  ))}
                </Stack>
              ) : null}
              {batch ? (
                <Stack gap={4}>
                  <SectionLabel>Delivery</SectionLabel>
                  <BatchPanel
                    batch={batch}
                    workstreams={workstreams}
                    gateCommand={gateCommand}
                    onOpenWorkbench={onOpenWorkbench}
                  />
                </Stack>
              ) : null}
              {latestRound ? (
                <Group gap="xs" data-testid="latest-review">
                  <SectionLabel>Latest review</SectionLabel>
                  <Text size="sm" c={roundVerdict(workstream?.steps ?? [], latestRound).color}>
                    {`${roundVerdict(workstream?.steps ?? [], latestRound).label} by ${roundReviewer(latestRound)}`}
                  </Text>
                  <RelativeTime at={latestRound.result.at} />
                  <Anchor
                    component="button"
                    type="button"
                    size="sm"
                    onClick={() => {
                      setTab('reviews');
                    }}
                  >
                    Reviews <span aria-hidden>›</span>
                  </Anchor>
                </Group>
              ) : null}
              <TaskPictures taskId={task.id} />
              <TaskSizeLine taskId={task.id} />
              <PlanContextDisclosure taskId={task.id} />
              {onOpenConversation ? (
                <OpenConversation target={{ taskId: task.id }} onOpen={onOpenConversation} />
              ) : null}
              <CopyTaskId id={task.id} />
            </Stack>
          </Tabs.Panel>
          <Tabs.Panel value="reviews" pt="md">
            {workstream && rounds.length > 0 ? (
              <ReviewRoundsList steps={workstream.steps} />
            ) : (
              <Text size="sm" c="dimmed">
                Nobody has reviewed this task yet.
              </Text>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="edit" pt="md">
            <Stack gap="lg">
              <HeadlineField value={headline} onChange={setHeadline} />
              <WhyField value={why} onChange={setWhy} />
              <TextInput
                label="Title"
                fw={600}
                value={title}
                onChange={(e) => {
                  setTitle(e.currentTarget.value);
                }}
              />
              {areasEditable ? (
                <MultiSelect
                  label="Areas"
                  description="The parts of the project this task works in. They are fixed once it starts."
                  data={areaNames}
                  value={areas}
                  onChange={setAreas}
                />
              ) : task.areas.length > 0 ? (
                <Stack gap={4}>
                  <Text size="sm" fw={500}>
                    Areas
                  </Text>
                  <Group gap={6}>
                    {task.areas.map((area) => (
                      <Badge key={area} size="sm" variant="light" color="gray" tt="none" fw={500}>
                        {area}
                      </Badge>
                    ))}
                  </Group>
                </Stack>
              ) : null}
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
              {accountId === undefined ? null : (
                <ModelSettingSelect
                  label="Model"
                  description="Overrides the setting for its role and any pattern that matches. No override leaves them in charge."
                  accountIds={[accountId]}
                  value={modelSetting}
                  noneLabel="No override"
                  onChange={setModelSetting}
                />
              )}
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
              {placementIsOpen ? <PlacementBadge task={task} /> : null}
              {placementIsOpen && placementEditable ? (
                <Stack gap={4}>
                  <PlacementChoice
                    task={task}
                    showReason={false}
                    pending={placementPatch.isPending}
                    onChange={(workspaceMode) => {
                      placementPatch.mutate({ taskId: task.id, patch: { workspaceMode } });
                    }}
                  />
                  {placementPatch.error ? (
                    <Text size="sm" c="red" role="alert">
                      {placementPatch.error.message}
                    </Text>
                  ) : null}
                </Stack>
              ) : null}
            </Stack>
            {/* Pinned to the drawer's bottom edge, so Save never scrolls away. It is on Edit alone. */}
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
          </Tabs.Panel>
        </Tabs>
      </Stack>
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

/** The small caps label above an Overview section. */
function SectionLabel({ children }: { readonly children: string }) {
  return (
    <Text size="xs" fw={600} c="dimmed" tt="uppercase">
      {children}
    </Text>
  );
}

/**
 * What stands beside the task's state that asks the builder nothing: another task's hazard it waits
 * for, a conflict its batch has with the base. The line is what the card says; the body says the rest
 * and how to fix it, with its line breaks. Nothing when there is none.
 */
function TaskNotices({
  notices,
  onOpenWorkbench,
}: {
  readonly notices: readonly Notice[];
  readonly onOpenWorkbench?: () => void;
}) {
  if (notices.length === 0) return null;
  return (
    <Stack gap="xs" data-testid="task-notice">
      {notices.map((notice) => (
        <Alert
          key={notice.key}
          variant="light"
          color={notice.tone === 'warning' ? 'orange' : 'blue'}
          title={notice.line}
        >
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {notice.body}
          </Text>
          {notice.key === PASS_FOLDER_WAIT_NOTICE_KEY && onOpenWorkbench ? (
            <Anchor component="button" type="button" size="sm" mt="xs" onClick={onOpenWorkbench}>
              Open UI Workbench
            </Anchor>
          ) : null}
        </Alert>
      ))}
    </Stack>
  );
}

/**
 * The one status line: where the task stands, where its checks stand, the links out to its pull
 * request and CI job, and what the builder can do about the run. For a failed run it adds why; for a
 * queued one its place in line, Run Next and Hold; for a held one Start and Remove. The state is the
 * run's while it is live or failed, else the column the card sits in ("In review", "Done").
 */
function StatusLine({
  task,
  columnName,
  workstream,
  holdable,
  batch,
  batches,
  place,
  onClosed,
  onCancelRun,
}: {
  readonly onCancelRun?: (workstream: WorkstreamDto) => void;
  readonly task: TaskDto;
  readonly columnName: string;
  readonly workstream: WorkstreamDto | undefined;
  /** Hold for a started task that has not run, or why it can't be held; null when there is nothing to hold. */
  readonly holdable: HoldOption | null;
  readonly batch: BatchDto | undefined;
  readonly batches: readonly BatchDto[];
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
  const startOver = useStartTaskOver();
  const remove = useRemoveTask();
  const failed = workstream !== undefined && canRetry(workstream.state);
  // A run the daemon would refuse to retry (shipped anyway, closed, parked, replaced, moved) offers no
  // Retry; once its pull request closed, the panel below closes it.
  const retryable = workstream !== undefined && canRetryRun(task, workstream, batch);
  const startableOver = workstream !== undefined && canStartOver(task, workstream, batch);
  const closable =
    workstream !== undefined && canCloseRun(workstream, batch) && !pullRequestClosed(batch);
  // A parked task never takes a lane, so putting it first would change nothing.
  const queued = workstream !== undefined && canRunNext(task, workstream.state);
  const held = isHeld(workstream);
  // A finished run is no state to show: the column says it. A live, held or failed one is.
  const runState = workstream !== undefined && (!isTerminal(workstream.state) || failed);
  const ci = ciLine(batch, batches);
  // A CI link to the pull request itself (queued, conflicting) would repeat the pull request link.
  const ciLink = ci?.link && ci.link.url !== batch?.prUrl ? ci.link : null;
  const busy = hold.isPending || start.isPending || startOver.isPending || remove.isPending;
  const refusal = [hold, start, startOver, remove].find((m) => m.error)?.error?.message ?? null;
  return (
    <Stack gap={4} data-testid="status-line">
      <Group justify="space-between" align="center" gap="xs">
        <Group gap="xs" align="center">
          {runState ? (
            <StateBadge state={workstream.state} />
          ) : (
            <Text size="sm" fw={500}>
              {columnName}
            </Text>
          )}
          {queued && place !== undefined ? (
            <Text size="xs" c="dimmed">
              {place === 1 ? 'next in line' : `${ordinal(place)} in line`}
            </Text>
          ) : null}
          {ci ? (
            <>
              <Text size="sm" c="dimmed" aria-hidden>
                ·
              </Text>
              <Text size="sm" c={ci.color} data-testid="ci-line" data-color={ci.color}>
                {ciStatus(ci.line)}
              </Text>
            </>
          ) : null}
          {batch?.prUrl ? <PullRequestLink url={batch.prUrl} /> : null}
          {ciLink ? <ExternalLink url={ciLink.url} label={ciLink.label} /> : null}
        </Group>
        <Group gap="xs">
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
          {holdable?.kind === 'hold' ? (
            <Button
              size="xs"
              variant="default"
              disabled={busy}
              loading={hold.isPending}
              onClick={() => {
                hold.mutate(taskId);
              }}
            >
              Hold
            </Button>
          ) : null}
          {holdable?.kind === 'refused' ? (
            // A disabled button gets no pointer events, so the tooltip hangs on its wrapper. The reason
            // never names the task: the builder is already looking at it.
            <Tooltip label={holdable.reason} withArrow>
              <span data-testid="hold-refused">
                <Button size="xs" variant="default" disabled aria-description={holdable.reason}>
                  Hold
                </Button>
              </span>
            </Tooltip>
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
          {retryable ? (
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
          {startableOver ? (
            <Button
              size="xs"
              variant="default"
              title="Starts the task again from the base branch in a new batch; the failed attempt's batch is abandoned and its branch kept."
              disabled={busy}
              loading={startOver.isPending}
              onClick={() => {
                closeTask.reset();
                retry.reset();
                startOver.mutate(taskId);
              }}
            >
              Start over
            </Button>
          ) : null}
          {onCancelRun && workstream && canCancelRun(task, workstream) ? (
            <Button
              size="xs"
              variant="default"
              color="red"
              disabled={busy}
              onClick={() => {
                onCancelRun(workstream);
              }}
            >
              Cancel Run
            </Button>
          ) : null}
          {closable ? (
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
      {/* A run that offers no Retry is told what happened, not what Retry would do. */}
      {failed ? <Text size="sm">{failureLine(workstream, retryable)}</Text> : null}
      {failed && workstream.failureReason !== null ? (
        <Text size="xs" c="dimmed">
          {workstream.failureReason}
        </Text>
      ) : null}
      {retryable ? (
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
      {closable ? (
        <Text size="xs" c="dimmed">
          {closeNote(batch)}
        </Text>
      ) : null}
      {runNext.data ? (
        <Text size="xs" c="dimmed">
          {runNextNote(null, runNext.data.waitingOn)}
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

/**
 * A task whose pull request closed without merging goes back to the builder: run it again, or close
 * it to take it off the Board. A finished task is reopened into Ready; a failed run shipped anyway
 * is still open, so it is started again (`onStart`) from where it is.
 */
function ClosedPullRequest({
  taskId,
  batch,
  onClosed,
  onStart,
}: {
  readonly taskId: TaskId;
  readonly batch: BatchDto;
  readonly onClosed: () => void;
  readonly onStart?: () => void;
}) {
  const reopen = useReopenTask();
  const closeTask = useCloseTask();
  const error = reopen.error ?? closeTask.error;
  return (
    <Stack gap={4}>
      <Text size="sm" c="red">
        The pull request closed without merging.
      </Text>
      <Group gap="xs" wrap="nowrap">
        {onStart ? (
          <Button
            size="xs"
            variant="default"
            onClick={() => {
              closeTask.reset();
              onStart();
              onClosed();
            }}
          >
            Start again
          </Button>
        ) : (
          <Button
            size="xs"
            variant="default"
            loading={reopen.isPending}
            onClick={() => {
              closeTask.reset();
              reopen.mutate(taskId, { onSuccess: onClosed });
            }}
          >
            Reopen task
          </Button>
        )}
        <Button
          size="xs"
          variant="default"
          loading={closeTask.isPending}
          onClick={() => {
            reopen.reset();
            closeTask.mutate(taskId, { onSuccess: onClosed });
          }}
        >
          Close task
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        {onStart
          ? 'Start again runs the task afresh.'
          : 'Reopen puts the task back in Ready to run again.'}{' '}
        {closeNote(batch)}
      </Text>
      {error ? (
        <Text size="xs" c="red" role="alert">{`Couldn't update the task: ${error.message}`}</Text>
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
