import { AccountId, Delivery, runsAgents, ToolName, type ProjectDto } from '@10db/contracts';
import { Stack, TextInput } from '@mantine/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { useInspectFolder, useProposeAreas } from '../../daemon/folder-queries';
import { useCreateProject, useSystemCheck } from '../../daemon/queries';
import { AccountSelect } from '../settings/account-select';
import { cantRunAgents } from '../settings/accounts/used-by';
import {
  areasOf,
  draftProblems,
  draftsFromAreas,
  WHOLE_REPOSITORY,
  type AreaDraft,
} from './area-drafts';
import { AreasField } from './areas-field';
import { DeliveryField } from './delivery-field';
import { pullRequestBlock } from './delivery-availability';
import { FolderField, type FolderState } from './folder-field';
import { GateField } from './gate-field';
import { RegistryHostsField } from './registry-hosts-field';
import { toProjectInput } from './project-input';

export interface ProjectSetup {
  /** The fields, ready to place in a step or a modal body. */
  readonly fields: ReactNode;
  readonly submit: () => void;
  readonly canSubmit: boolean;
  readonly pending: boolean;
  /** Why the last submit failed, ready to show beside the submit button. */
  readonly error: string | null;
}

/**
 * How long setup waits for the daemon's proposal before it starts from one area. Longer than the
 * daemon's own bound on the model (30 s), which leaves the git survey time to finish first.
 */
const PROPOSAL_MS = 45_000;

interface Prefilled {
  readonly name: string;
  readonly gate: string;
  readonly baseBranch: string;
}

/** The state, fields and submit for adding a project; the first run and the New Project modal share it. */
export function useProjectSetup(
  onCreated: (project: ProjectDto) => void,
  options: { readonly proposalMs?: number } = {},
): ProjectSetup {
  const proposalMs = options.proposalMs ?? PROPOSAL_MS;
  const inspect = useInspectFolder();
  const propose = useProposeAreas();
  const create = useCreateProject();
  const system = useSystemCheck();
  const ghLogin = system.data?.tools.find((t) => t.name === ToolName.Gh)?.signedIn ?? null;
  const accounts = (useAccounts().data ?? []).filter((a) => !a.archived);
  const [accountChoice, setAccountChoice] = useState<string | null>(null);
  const [typed, setTyped] = useState<Prefilled>({ name: '', gate: '', baseBranch: '' });
  const [deliveryChoice, setDeliveryChoice] = useState<Delivery | null>(null);
  // Null until the daemon has proposed areas for the folder, or has failed to.
  const [areas, setAreas] = useState<AreaDraft[] | null>(null);
  const [areaNote, setAreaNote] = useState<string | null>(null);

  const result = inspect.data;
  const inspection = result?.ok === true ? result.inspection : null;
  const folder: FolderState = inspect.isPending
    ? { kind: 'inspecting', path: inspect.variables }
    : inspect.isError
      ? { kind: 'refused', path: inspect.variables, message: inspect.error.message }
      : result === undefined
        ? { kind: 'idle' }
        : result.ok
          ? { kind: 'ready', path: inspect.variables, root: result.inspection.root }
          : { kind: 'refused', path: inspect.variables, message: result.message };

  /** Without a proposal the project still starts, from one area over every file for the builder to split. */
  const wholeRepository = (why: string) => {
    setAreas(draftsFromAreas([WHOLE_REPOSITORY]));
    setAreaNote(
      `Couldn't propose areas: ${why} One area covers the whole repository; split it here.`,
    );
  };

  /** The proposal in flight, if any: its request and the timer that gives up on it. */
  const inFlight = useRef<{ abort: AbortController; timer: number } | null>(null);

  /** Cancels the request, which stops the daemon's model question; nothing it answers is used. */
  const stopProposal = () => {
    const current = inFlight.current;
    if (current === null) return;
    inFlight.current = null;
    window.clearTimeout(current.timer);
    current.abort.abort();
    propose.reset();
  };

  // Closing the form, or leaving the view, abandons a proposal nobody is waiting for.
  useEffect(
    () => () => {
      const current = inFlight.current;
      if (current === null) return;
      inFlight.current = null;
      window.clearTimeout(current.timer);
      current.abort.abort();
    },
    [],
  );

  const proposeFor = (root: string) => {
    stopProposal();
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      if (inFlight.current?.abort !== abort) return;
      stopProposal();
      wholeRepository(`the proposal took longer than ${String(proposalMs / 1000)} s.`);
    }, proposalMs);
    inFlight.current = { abort, timer };
    // Settled answers are used only while this request is still the one in flight.
    const current = () => inFlight.current?.abort === abort;
    const settle = () => {
      if (!current()) return false;
      window.clearTimeout(timer);
      inFlight.current = null;
      return true;
    };
    propose.mutate(
      { path: root, signal: abort.signal },
      {
        onSuccess: (answer) => {
          if (!settle()) return;
          if (answer.ok) {
            setAreas(draftsFromAreas(answer.proposal.areas));
            setAreaNote(null);
          } else wholeRepository(answer.message);
        },
        onError: (error) => {
          if (!settle()) return;
          wholeRepository(error.message);
        },
      },
    );
  };

  const onInspect = (path: string) => {
    create.reset();
    // The last folder's proposal and the builder's edits to it belong to that folder only.
    stopProposal();
    setAreas(null);
    setAreaNote(null);
    inspect.mutate(path, {
      onSuccess: (answer) => {
        // A new folder starts from its own prefill, not the last folder's edits.
        setDeliveryChoice(null);
        if (answer.ok) {
          setTyped({
            name: answer.inspection.suggestedName,
            gate: answer.inspection.gateCandidates[0]?.command ?? '',
            baseBranch: answer.inspection.defaultBranch ?? '',
          });
          proposeFor(answer.inspection.root);
        }
      },
    });
  };

  // Until the system check answers, gh's login is unknown, so pull requests are not yet ruled out.
  const block =
    inspection === null || !system.isSuccess ? null : pullRequestBlock({ ghLogin, inspection });
  const delivery = block !== null ? Delivery.Local : (deliveryChoice ?? Delivery.PullRequest);
  // A project never runs on an OpenRouter account, so it neither defaults to one nor counts as a choice.
  const agentAccounts = accounts.filter((a) => runsAgents(a.kind));
  const accountId =
    accountChoice ?? agentAccounts.find((a) => a.isDefault)?.id ?? agentAccounts[0]?.id ?? null;
  const chooseAccount = agentAccounts.length > 1;

  // Null areas with a folder chosen means the proposal is still out: the builder need not wait for it.
  const areasReady = areas === null || (areas.length > 0 && draftProblems(areas).rows.size === 0);
  const canSubmit =
    inspection !== null &&
    areasReady &&
    typed.name.trim() !== '' &&
    (delivery === Delivery.Local || typed.baseBranch !== '');

  const submit = () => {
    if (inspection === null || !canSubmit) return;
    // Creating without waiting: the proposal is dropped, and the project starts from one area over
    // every file, which the builder can split later in Settings.
    let chosen = areas;
    if (chosen === null) {
      stopProposal();
      chosen = draftsFromAreas([WHOLE_REPOSITORY]);
      setAreas(chosen);
      setAreaNote(
        'Stopped waiting for proposed areas. One area covers the whole repository; split it here.',
      );
    }
    create.mutate(
      toProjectInput({
        name: typed.name,
        root: inspection.root,
        gateCommand: typed.gate,
        delivery,
        baseBranch: typed.baseBranch,
        areas: areasOf(chosen),
        accountId: chooseAccount && accountId !== null ? AccountId.parse(accountId) : null,
      }),
      { onSuccess: onCreated },
    );
  };

  const fields = (
    <Stack gap="lg">
      <FolderField state={folder} onInspect={onInspect} />
      {inspection === null ? null : (
        <>
          <TextInput
            label="Name"
            value={typed.name}
            onChange={(e) => {
              setTyped({ ...typed, name: e.currentTarget.value });
            }}
          />
          <GateField
            value={typed.gate}
            candidates={inspection.gateCandidates}
            onChange={(gate) => {
              setTyped({ ...typed, gate });
            }}
          />
          {chooseAccount ? (
            <AccountSelect
              label="Account"
              description="Whose Claude login runs this project's sessions"
              accounts={accounts}
              isDisabled={cantRunAgents}
              value={accountId}
              allowDeselect={false}
              onChange={setAccountChoice}
            />
          ) : null}
          <AreasField drafts={areas} note={areaNote} onChange={setAreas} />
          <RegistryHostsField hosts={inspection.registryHosts} />
          <DeliveryField
            delivery={delivery}
            onDelivery={setDeliveryChoice}
            pullRequestBlock={block}
            branches={inspection.branches}
            baseBranch={typed.baseBranch}
            onBaseBranch={(baseBranch) => {
              setTyped({ ...typed, baseBranch });
            }}
          />
        </>
      )}
    </Stack>
  );

  return {
    fields,
    submit,
    canSubmit,
    pending: create.isPending,
    error: create.isError ? `Couldn't create the project: ${create.error.message}` : null,
  };
}
