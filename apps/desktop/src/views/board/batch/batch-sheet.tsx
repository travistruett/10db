import {
  batchBranchStem,
  Delivery,
  PICK_MAX,
  WorkspaceMode,
  type GoalId,
  type PickerProposalDto,
  type ProjectViewDto,
} from '@10db/contracts';
import {
  Alert,
  Button,
  Code,
  Drawer,
  Group,
  List,
  Loader,
  NumberInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { useCandidates } from '../../../daemon/queries';
import { BatchCandidate } from './batch-candidate';
import { initialSelection, orderedSelection, startBlockers, toggle } from './batch-selection';
import { sheetMode, submitLabel, type SheetMode } from './sheet-mode';
import { useStartWork } from './use-start-work';

function ModeNote({ mode }: { readonly mode: SheetMode }) {
  switch (mode.kind) {
    case 'local':
      return (
        <Text size="sm" c="dimmed">
          This project delivers locally: each task starts on its own, on the current branch.
        </Text>
      );
    case 'new_batch':
      return (
        <Text size="sm" c="dimmed">
          These tasks start a new batch with its own branch, and one pull request when they’re all
          done.
        </Text>
      );
    case 'worktrees':
      return (
        <Text size="sm" c="dimmed">
          Each task gets its own copy, branch and pull request.
        </Text>
      );
    case 'join':
      return <Text size="sm">{`These tasks join ${mode.title}, on its branch.`}</Text>;
    case 'fix':
      return (
        <Text size="sm">{`${mode.title} failed to ship. Starting these tasks reopens it as a fix.`}</Text>
      );
    case 'busy':
      // The reason shows with the other blockers above the Start button.
      return null;
  }
}

/** Tasks that go in a separate copy, said under the shared batch's own note when the two mix. */
function CopiesNote({ titles }: { readonly titles: readonly string[] }) {
  const [only] = titles;
  if (only === undefined) return null;
  return (
    <Text size="sm" c="dimmed">
      {titles.length === 1
        ? `${only} gets its own copy, branch and pull request.`
        : `${String(titles.length)} tasks each get their own copy, branch and pull request.`}
    </Text>
  );
}

interface ChoicesProps {
  readonly project: ProjectViewDto;
  readonly proposal: PickerProposalDto;
  readonly onStarted: () => void;
}

function Choices({ project, proposal, onStarted }: ChoicesProps) {
  const [selection, setSelection] = useState(() => initialSelection(proposal));
  const ordered = orderedSelection(proposal, selection);
  const candidateOf = new Map(proposal.candidates.map((c) => [c.task.id, c.task]));
  const titleOf = new Map(proposal.candidates.map((c) => [c.task.id, c.task.title]));
  const placements = ordered.map(
    (id) => candidateOf.get(id)?.workspaceMode ?? WorkspaceMode.Shared,
  );
  const mode = sheetMode(project, placements);
  const copyTitles = ordered.flatMap((id, i) =>
    placements[i] === WorkspaceMode.Worktree ? [titleOf.get(id) ?? id] : [],
  );
  const [title, setTitle] = useState<string | null>(null);
  // Until the builder types one, the batch is named after the first ticked task that goes in Your folder.
  const first = ordered.find((_, i) => placements[i] !== WorkspaceMode.Worktree) ?? ordered[0];
  const batchTitle = title ?? (first === undefined ? '' : (titleOf.get(first) ?? ''));
  const start = useStartWork(project.id);
  const blockers = startBlockers(proposal, selection, mode, batchTitle);
  const placementEditable = project.delivery === Delivery.PullRequest;
  if (proposal.candidates.length === 0)
    return (
      <Text c="dimmed">No ready tasks. A task is ready when everything it depends on is done.</Text>
    );
  return (
    <Stack>
      <ModeNote mode={mode} />
      {mode.kind === 'worktrees' ? null : <CopiesNote titles={copyTitles} />}
      {mode.kind === 'new_batch' ? (
        <>
          <TextInput
            label="Batch title"
            description="The pull request's title, after the project's prefix."
            value={batchTitle}
            onChange={(e) => {
              setTitle(e.currentTarget.value);
            }}
          />
          <Text size="sm">
            Starting switches your checkout to a new branch,{' '}
            <Code>{`${batchBranchStem(batchTitle)}-…`}</Code>, cut from{' '}
            <Code>{`origin/${project.baseBranch}`}</Code> (the … is a short id added when it
            starts). Your checkout must be clean, with nothing uncommitted. When the batch ends,
            10db switches it back to where it was, unless it has uncommitted changes or you moved
            it.
          </Text>
        </>
      ) : null}
      {proposal.candidates.map((c) => (
        <BatchCandidate
          key={c.task.id}
          candidate={c}
          placementEditable={placementEditable}
          ticked={selection.has(c.task.id)}
          onToggle={() => {
            setSelection((s) => toggle(s, c.task.id));
          }}
        />
      ))}
      <Text size="sm">
        {project.gateCommand === null ? (
          'Verification: none. Each finished task waits for you to check it.'
        ) : (
          <>
            Verification: 10db runs{' '}
            <Code>{project.changedCheckCommand ?? project.gateCommand}</Code> after each implement
            step
            {project.changedCheckCommand === null ? null : (
              <>
                , and <Code>{project.gateCommand}</Code> before the push
              </>
            )}
            , and review steps must approve.
          </>
        )}
      </Text>
      {blockers.length > 0 ? (
        <List size="sm" c="yellow">
          {blockers.map((b) => (
            <List.Item key={b}>{b}</List.Item>
          ))}
        </List>
      ) : null}
      {start.error ? (
        <Alert color="red" title="Couldn't start the work">
          {start.error.message}
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <Button
          disabled={blockers.length > 0}
          loading={start.isPending}
          onClick={() => {
            start.mutate(
              {
                mode,
                title: batchTitle,
                tasks: ordered.map((id) => ({ id, title: titleOf.get(id) ?? id })),
              },
              { onSuccess: onStarted },
            );
          }}
        >
          {submitLabel(mode, ordered.length, copyTitles.length)}
        </Button>
      </Group>
    </Stack>
  );
}

export interface BatchSheetProps {
  readonly project: ProjectViewDto;
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Limits the proposal to this goal's tasks; absent, it draws on every ready task. */
  readonly goal?: { readonly id: GoalId; readonly title: string };
}

/** Spec §5.2.4: what each picked task will run, before anything starts. */
export function BatchSheet({ project, opened, onClose, goal }: BatchSheetProps) {
  const [size, setSize] = useState(project.maxLanes);
  const proposal = useCandidates(project.id, size, opened, goal?.id ?? null);
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xl"
      title="Start a batch"
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      <Stack>
        <NumberInput
          label="Batch size"
          min={1}
          max={PICK_MAX}
          value={size}
          onChange={(v) => {
            if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= PICK_MAX) setSize(v);
          }}
        />
        <Text size="sm" c="dimmed">
          Chosen by the picker’s rules: ready tasks, resumed work first, then the work that unblocks
          most, then board order. Tasks whose areas collide are left out. The PM review isn’t built
          yet.
        </Text>
        {goal ? <Text size="sm">{`Only tasks of the goal ${goal.title}.`}</Text> : null}
        {proposal.isError ? (
          <Alert color="red" title="Couldn't load the proposal">
            {proposal.error.message}
          </Alert>
        ) : null}
        {proposal.isPending && opened ? (
          <Loader size="sm" aria-label="Loading the proposal" />
        ) : null}
        {/* A new size is a new proposal, so the ticks and the title start over. */}
        {proposal.data ? (
          <Choices key={size} project={project} proposal={proposal.data} onStarted={onClose} />
        ) : null}
      </Stack>
    </Drawer>
  );
}
