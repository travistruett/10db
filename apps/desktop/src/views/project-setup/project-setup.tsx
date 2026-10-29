import { AccountId, Delivery, ToolName, type ProjectDto } from '@10db/contracts';
import { Stack, TextInput } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { useInspectFolder } from '../../daemon/folder-queries';
import { useCreateProject, useSystemCheck } from '../../daemon/queries';
import { AccountSelect } from '../settings/account-select';
import { DeliveryField } from './delivery-field';
import { pullRequestBlock } from './delivery-availability';
import { FolderField, type FolderState } from './folder-field';
import { GateField } from './gate-field';
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

interface Prefilled {
  readonly name: string;
  readonly gate: string;
  readonly baseBranch: string;
}

/** The state, fields and submit for adding a project; the first run and the New Project modal share it. */
export function useProjectSetup(onCreated: (project: ProjectDto) => void): ProjectSetup {
  const inspect = useInspectFolder();
  const create = useCreateProject();
  const system = useSystemCheck();
  const ghLogin = system.data?.tools.find((t) => t.name === ToolName.Gh)?.signedIn ?? null;
  const accounts = (useAccounts().data ?? []).filter((a) => !a.archived);
  const [accountChoice, setAccountChoice] = useState<string | null>(null);
  const [typed, setTyped] = useState<Prefilled>({ name: '', gate: '', baseBranch: '' });
  const [deliveryChoice, setDeliveryChoice] = useState<Delivery | null>(null);

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

  const onInspect = (path: string) => {
    create.reset();
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
        }
      },
    });
  };

  // Until the system check answers, gh's login is unknown, so pull requests are not yet ruled out.
  const block =
    inspection === null || !system.isSuccess ? null : pullRequestBlock({ ghLogin, inspection });
  const delivery = block !== null ? Delivery.Local : (deliveryChoice ?? Delivery.PullRequest);
  const accountId =
    accountChoice ?? accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? null;
  const chooseAccount = accounts.length > 1;

  const canSubmit =
    inspection !== null &&
    typed.name.trim() !== '' &&
    (delivery === Delivery.Local || typed.baseBranch !== '');

  const submit = () => {
    if (inspection === null || !canSubmit) return;
    create.mutate(
      toProjectInput({
        name: typed.name,
        root: inspection.root,
        gateCommand: typed.gate,
        delivery,
        baseBranch: typed.baseBranch,
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
              value={accountId}
              allowDeselect={false}
              onChange={setAccountChoice}
            />
          ) : null}
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
