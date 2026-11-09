import {
  KnowledgeItemKind,
  KnowledgeScope,
  KnowledgeState,
  type DecisionItem,
  type PrincipleItem,
  type ProjectViewDto,
  type ProposalDto,
} from '@10db/contracts';
import { ActionIcon, Button, Group, Menu } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import {
  useAcceptProposal,
  usePrincipleReplacePreview,
  useCreatePrinciple,
  useRecordDecision,
  useRejectProposal,
  useSupersedeDecision,
  useSupersedePrinciple,
} from '../../daemon/knowledge-queries';
import { DecisionDialog } from './decision-dialog';
import { PrincipleDialog } from './principle-dialog';
import { ReasonDialog } from './reason-dialog';
import { placeOf, recordTarget } from './target-select';
import { RemoveDialog } from './remove-dialog';

/** Which dialog a row or a proposal has open. */
const Open = {
  None: 'none',
  Edit: 'edit',
  Remove: 'remove',
  Accept: 'accept',
  Reject: 'reject',
} as const;
type Open = (typeof Open)[keyof typeof Open];

/**
 * The row's “⋯” menu; the record's own words name it, since a list holds many. It leaves the page the
 * moment it closes: a menu that fades out stays mounted for a moment, and the next one opens beside it,
 * so two Remove… items can be in the page at once.
 */
function RowMenu({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Menu position="bottom-end" transitionProps={{ duration: 0 }}>
      <Menu.Target>
        <ActionIcon variant="subtle" size="sm" aria-label={`Actions for ${label}`}>
          <IconDots size={16} stroke={1.5} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{children}</Menu.Dropdown>
    </Menu>
  );
}

/** A write that names a project (not You) keeps the record in the project the builder is looking at. */
const inProject = (
  target: { readonly scope: KnowledgeScope },
  project: ProjectViewDto,
): { readonly projectId?: ProjectViewDto['id'] } =>
  target.scope === KnowledgeScope.You ? {} : { projectId: project.id };

export function NewDecisionButton({ project }: { readonly project: ProjectViewDto }) {
  const [open, setOpen] = useState(false);
  const record = useRecordDecision(project.id);
  const close = () => {
    record.reset();
    setOpen(false);
  };
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        New Decision
      </Button>
      {open ? (
        <DecisionDialog
          project={project}
          title="New Decision"
          submitLabel="Record"
          pending={record.isPending}
          error={record.error?.message ?? null}
          onSubmit={({ target, ...text }) => {
            record.mutate({ ...placeOf(target), ...text }, { onSuccess: close });
          }}
          onClose={close}
        />
      ) : null}
    </>
  );
}

export function NewPrincipleButton({ project }: { readonly project: ProjectViewDto }) {
  const [open, setOpen] = useState(false);
  const create = useCreatePrinciple(project.id);
  const previews = usePrincipleReplacePreview();
  const close = () => {
    create.reset();
    setOpen(false);
  };
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        New Principle
      </Button>
      {open ? (
        <PrincipleDialog
          project={project}
          title="New Principle"
          submitLabel="Save"
          pending={create.isPending}
          error={create.error?.message ?? null}
          preview={({ target, ...text }) =>
            previews.create(project.id, { ...placeOf(target), ...text })
          }
          onSubmit={({ target, ...text }) => {
            create.mutate({ ...placeOf(target), ...text }, { onSuccess: close });
          }}
          onClose={close}
        />
      ) : null}
    </>
  );
}

/**
 * A decision row's menu. Edit writes a successor and moves this one to Past; Remove… is offered on
 * an older version too, where its dialog says which record to remove instead.
 */
export function DecisionActions({
  project,
  decision,
}: {
  readonly project: ProjectViewDto;
  readonly decision: DecisionItem;
}) {
  const [open, setOpen] = useState<Open>(Open.None);
  const supersede = useSupersedeDecision();
  const current = decision.state === KnowledgeState.Current;
  if (!current && decision.state !== KnowledgeState.Superseded) return null;
  const close = () => {
    supersede.reset();
    setOpen(Open.None);
  };
  return (
    <>
      <RowMenu label={`"${decision.question}"`}>
        {current ? (
          <Menu.Item
            onClick={() => {
              setOpen(Open.Edit);
            }}
          >
            Edit…
          </Menu.Item>
        ) : null}
        <Menu.Item
          color="red"
          onClick={() => {
            setOpen(Open.Remove);
          }}
        >
          Remove…
        </Menu.Item>
      </RowMenu>
      {open === Open.Edit ? (
        <DecisionDialog
          project={project}
          title="Edit Decision"
          submitLabel="Save"
          initial={{
            target: recordTarget(decision, project.id),
            question: decision.question,
            choice: decision.choice,
            rationale: decision.rationale,
          }}
          pending={supersede.isPending}
          error={supersede.error?.message ?? null}
          onSubmit={({ target, ...text }) => {
            supersede.mutate(
              {
                id: decision.id,
                input: { ...placeOf(target), ...inProject(target, project), ...text },
              },
              { onSuccess: close },
            );
          }}
          onClose={close}
        />
      ) : null}
      {open === Open.Remove ? (
        <RemoveDialog
          record={{
            kind: KnowledgeItemKind.Decision,
            id: decision.id,
            label: decision.question,
            state: decision.state,
          }}
          onClose={close}
        />
      ) : null}
    </>
  );
}

/** A principle row's menu: Edit… (a successor that keeps the key) and Remove…, which asks why. */
export function PrincipleActions({
  project,
  principle,
}: {
  readonly project: ProjectViewDto;
  readonly principle: PrincipleItem;
}) {
  const [open, setOpen] = useState<Open>(Open.None);
  const supersede = useSupersedePrinciple();
  const current = principle.state === KnowledgeState.Current;
  if (!current && principle.state !== KnowledgeState.Superseded) return null;
  const close = () => {
    supersede.reset();
    setOpen(Open.None);
  };
  return (
    <>
      <RowMenu label={`"${principle.statement}"`}>
        {current ? (
          <>
            <Menu.Item
              onClick={() => {
                setOpen(Open.Edit);
              }}
            >
              Edit…
            </Menu.Item>
          </>
        ) : null}
        <Menu.Item
          color="red"
          onClick={() => {
            setOpen(Open.Remove);
          }}
        >
          Remove…
        </Menu.Item>
      </RowMenu>
      {open === Open.Edit ? (
        <PrincipleDialog
          project={project}
          title="Edit Principle"
          submitLabel="Save"
          initial={{
            target: recordTarget(principle, project.id),
            statement: principle.statement,
            kind: principle.principleKind,
            topicKey: principle.topicKey,
          }}
          pending={supersede.isPending}
          error={supersede.error?.message ?? null}
          onSubmit={({ target, ...text }) => {
            supersede.mutate(
              {
                id: principle.id,
                input: { ...placeOf(target), ...inProject(target, project), ...text },
              },
              { onSuccess: close },
            );
          }}
          onClose={close}
        />
      ) : null}
      {open === Open.Remove ? (
        <RemoveDialog
          record={{
            kind: KnowledgeItemKind.Principle,
            id: principle.id,
            label: principle.statement,
            state: principle.state,
          }}
          onClose={close}
        />
      ) : null}
    </>
  );
}

/**
 * Accept… and Reject… on a pending principle proposal; either closes its Inbox card. Any other
 * proposal is answered in the Inbox.
 */
export function ProposalActions({
  project,
  proposal,
}: {
  readonly project: ProjectViewDto;
  readonly proposal: ProposalDto;
}) {
  const [open, setOpen] = useState<Open>(Open.None);
  const accept = useAcceptProposal();
  const previews = usePrincipleReplacePreview();
  const reject = useRejectProposal();
  const principle = proposal.principle;
  if (principle === null) return null;
  const close = () => {
    accept.reset();
    reject.reset();
    setOpen(Open.None);
  };
  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        size="xs"
        onClick={() => {
          setOpen(Open.Accept);
        }}
      >
        Accept…
      </Button>
      <Button
        size="xs"
        variant="default"
        onClick={() => {
          setOpen(Open.Reject);
        }}
      >
        Reject…
      </Button>
      {open === Open.Accept ? (
        <PrincipleDialog
          project={project}
          title="Accept Proposal"
          submitLabel="Accept"
          initial={{
            target: recordTarget(principle, project.id),
            statement: principle.statement,
            kind: principle.kind,
            topicKey: principle.topicKey,
          }}
          pending={accept.isPending}
          error={accept.error?.message ?? null}
          preview={({ target, ...text }) =>
            previews.accept(proposal.id, { ...placeOf(target), ...text })
          }
          onSubmit={({ target, ...text }) => {
            accept.mutate(
              { id: proposal.id, input: { ...placeOf(target), ...text } },
              { onSuccess: close },
            );
          }}
          onClose={close}
        />
      ) : null}
      {open === Open.Reject ? (
        <ReasonDialog
          title="Reject Proposal"
          intro={`“${principle.statement}” is not kept as a principle. The proposal leaves the Inbox.`}
          submitLabel="Reject"
          required={false}
          pending={reject.isPending}
          error={reject.error?.message ?? null}
          onSubmit={(note) => {
            reject.mutate(
              { id: proposal.id, input: note === '' ? {} : { note } },
              { onSuccess: close },
            );
          }}
          onClose={close}
        />
      ) : null}
    </Group>
  );
}
