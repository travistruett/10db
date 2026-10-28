import {
  AccountId,
  BranchName,
  DEFAULT_WORKTREE_SEED,
  Delivery,
  PrTitlePrefix,
  WorkspaceMode,
  WorktreeSeedName,
  type ProjectDto,
} from '@10db/contracts';
import {
  Alert,
  Button,
  Group,
  NumberInput,
  Radio,
  Select,
  Stack,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useState, type SyntheticEvent } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { useCreateProject } from '../../daemon/queries';
import { accountOptions } from '../settings/account-kind-label';
import { WorkspaceFields } from '../settings/workspace-fields';
import { parseAreas } from './areas-text';

/** Starting heuristics (spec §15); the daemon validates the final values. */
const DEFAULT_HANDOFF_PCT = 40;
const DEFAULT_NUDGE_PCT = 50;
const MAX_NUDGE_PCT = 98;

/** The firm nudge must sit above the handoff threshold. */
function nudgeFor(handoffPct: number): number {
  return Math.min(MAX_NUDGE_PCT, Math.max(DEFAULT_NUDGE_PCT, handoffPct + 1));
}

export function NewProjectForm({
  onCreated,
}: {
  readonly onCreated: (project: ProjectDto) => void;
}) {
  const create = useCreateProject();
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [gateCommand, setGateCommand] = useState('');
  const [areasText, setAreasText] = useState('');
  const accounts = useAccounts().data ?? [];
  const [accountId, setAccountId] = useState<string | null>(null);
  // Until the builder picks one, the default account ("Claude plan" on a fresh install) is shown and sent.
  const chosen = accountId ?? accounts.find((a) => a.isDefault && !a.archived)?.id ?? null;
  const [handoffPct, setHandoffPct] = useState<number | ''>(DEFAULT_HANDOFF_PCT);
  const [delivery, setDelivery] = useState<Delivery>(Delivery.Local);
  const [baseBranch, setBaseBranch] = useState('main');
  const [prTitlePrefix, setPrTitlePrefix] = useState('');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(WorkspaceMode.Shared);
  const [worktreeSeed, setWorktreeSeed] = useState<string[]>([...DEFAULT_WORKTREE_SEED]);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = parseAreas(areasText);
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    if (handoffPct === '') {
      setFormError('Enter the handoff percentage');
      return;
    }
    const pullRequests = delivery === Delivery.PullRequest;
    if (pullRequests && !PrTitlePrefix.safeParse(prTitlePrefix.trim()).success) {
      setFormError('Enter a PR title prefix such as feat(app)');
      return;
    }
    if (pullRequests && !BranchName.safeParse(baseBranch.trim()).success) {
      setFormError('Enter the base branch, such as main');
      return;
    }
    const worktrees = pullRequests && workspaceMode === WorkspaceMode.Worktree;
    const seed = worktreeSeed.map((name) => name.trim()).filter((name) => name !== '');
    if (worktrees && !seed.every((name) => WorktreeSeedName.safeParse(name).success)) {
      setFormError('Seed names are single directories: no slash, ".", ".." or ".git"');
      return;
    }
    setFormError(null);
    create.mutate(
      {
        name: name.trim(),
        repoPath: repoPath.trim(),
        gateCommand: gateCommand.trim(),
        areas: parsed.areas,
        ...(chosen ? { accountId: AccountId.parse(chosen) } : {}),
        handoffPct,
        nudgePct: nudgeFor(handoffPct),
        delivery,
        ...(pullRequests
          ? { baseBranch: baseBranch.trim(), prTitlePrefix: prTitlePrefix.trim() }
          : {}),
        ...(worktrees ? { workspaceMode, worktreeSeed: seed } : {}),
      },
      {
        onSuccess: (project) => {
          onCreated(project);
        },
      },
    );
  };

  const error = formError ?? create.error?.message ?? null;
  return (
    <form onSubmit={submit} noValidate>
      <Stack>
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
        />
        <TextInput
          label="Repository path"
          description="Absolute path to the git checkout"
          placeholder="/path/to/your/checkout"
          ff="monospace"
          value={repoPath}
          onChange={(e) => {
            setRepoPath(e.currentTarget.value);
          }}
        />
        <TextInput
          label="Gate command"
          description="10db runs this to verify a task is done"
          placeholder="make gate"
          ff="monospace"
          value={gateCommand}
          onChange={(e) => {
            setGateCommand(e.currentTarget.value);
          }}
        />
        <Textarea
          label="Areas"
          description="One per line: name: glob, glob"
          placeholder="src: src/**"
          ff="monospace"
          autosize
          minRows={3}
          value={areasText}
          onChange={(e) => {
            setAreasText(e.currentTarget.value);
          }}
        />
        <Select
          label="Account"
          description="Who pays for this project's sessions"
          data={accountOptions(accounts)}
          value={chosen}
          allowDeselect={false}
          onChange={(value) => {
            setAccountId(value);
          }}
        />
        <Radio.Group
          label="Delivery"
          value={delivery}
          onChange={(value) => {
            setDelivery(value === Delivery.PullRequest ? Delivery.PullRequest : Delivery.Local);
          }}
        >
          <Group mt="xs">
            <Radio value={Delivery.Local} label="Commits on the checked-out branch" />
            <Radio value={Delivery.PullRequest} label="One pull request per batch" />
          </Group>
        </Radio.Group>
        {delivery === Delivery.PullRequest ? (
          <>
            <TextInput
              label="Base branch"
              description="The branch on origin each batch starts from and targets"
              ff="monospace"
              value={baseBranch}
              onChange={(e) => {
                setBaseBranch(e.currentTarget.value);
              }}
            />
            <TextInput
              label="PR title prefix"
              description="A Conventional Commit type and scope; titles read feat(app): <batch title>"
              placeholder="feat(app)"
              ff="monospace"
              value={prTitlePrefix}
              onChange={(e) => {
                setPrTitlePrefix(e.currentTarget.value);
              }}
            />
            <WorkspaceFields
              workspaceMode={workspaceMode}
              worktreeSeed={worktreeSeed}
              onChange={(change) => {
                if (change.workspaceMode !== undefined) setWorkspaceMode(change.workspaceMode);
                if (change.worktreeSeed !== undefined) setWorktreeSeed(change.worktreeSeed);
              }}
            />
          </>
        ) : null}
        <NumberInput
          label="Handoff at %"
          description="Context use at which a session hands off to a fresh one"
          allowDecimal={false}
          min={5}
          max={95}
          clampBehavior="strict"
          value={handoffPct}
          onChange={(value) => {
            setHandoffPct(typeof value === 'number' ? value : '');
          }}
        />
        {error ? (
          <Alert color="red" title="Couldn't create the project">
            {error}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button type="submit" loading={create.isPending}>
            Create project
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
