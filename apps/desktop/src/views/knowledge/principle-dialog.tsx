import {
  KnowledgeScope,
  PrincipleKind,
  TopicKey,
  topicKeyFrom,
  type KnowledgeTarget,
  type ProjectViewDto,
} from '@10db/contracts';
import { Button, Select, Stack, Textarea, TextInput } from '@mantine/core';
import { useId, useState, type SyntheticEvent } from 'react';
import { FormModal } from '../../shell/form-modal';
import { PRINCIPLE_KIND_LABELS } from './knowledge-labels';
import { TargetSelect } from './target-select';

export interface PrincipleFields {
  readonly target: KnowledgeTarget;
  readonly statement: string;
  readonly kind: PrincipleKind;
  readonly topicKey: TopicKey;
}

const KINDS: readonly string[] = Object.values(PrincipleKind);
const isKind = (v: string): v is PrincipleKind => KINDS.includes(v);

/**
 * New Principle, Edit Principle and Accept Proposal. The topic key follows the statement until the
 * builder edits it; a form that starts from an existing principle keeps that principle's key. The
 * caller mounts it when the builder opens it, so a form always starts from `initial` or empty.
 */
export function PrincipleDialog({
  project,
  title,
  submitLabel,
  keyHint,
  initial,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  readonly project: ProjectViewDto;
  readonly title: string;
  readonly submitLabel: string;
  /** What saving does to a principle with the same key, which differs between a new one and an edit. */
  readonly keyHint: string;
  readonly initial?: PrincipleFields;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (fields: PrincipleFields) => void;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const [statement, setStatement] = useState(initial?.statement ?? '');
  const [kind, setKind] = useState<PrincipleKind>(initial?.kind ?? PrincipleKind.Heuristic);
  const [keyEdited, setKeyEdited] = useState(initial !== undefined);
  const [topicKey, setTopicKey] = useState<string>(initial?.topicKey ?? '');
  const [target, setTarget] = useState<KnowledgeTarget>(
    initial?.target ?? { scope: KnowledgeScope.Project, projectId: project.id },
  );
  const [problem, setProblem] = useState<string | null>(null);
  const shownKey = keyEdited ? topicKey : statement.trim() ? topicKeyFrom(statement) : '';
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!statement.trim()) {
      setProblem('Write the statement.');
      return;
    }
    const key = TopicKey.safeParse(shownKey);
    if (!key.success) {
      setProblem(
        'The topic key is lowercase words joined by . or - (for example testing.no-sleeps).',
      );
      return;
    }
    setProblem(null);
    onSubmit({ target, statement: statement.trim(), kind, topicKey: key.data });
  };
  return (
    <FormModal
      opened
      onClose={onClose}
      title={title}
      size="md"
      error={problem ?? error}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <Stack gap="sm">
          <Textarea
            label="Statement"
            data-autofocus
            autosize
            minRows={2}
            value={statement}
            onChange={(e) => {
              setStatement(e.currentTarget.value);
            }}
          />
          <Select
            label="Kind"
            allowDeselect={false}
            checkIconPosition="right"
            data={Object.values(PrincipleKind).map((k) => ({
              value: k,
              label: PRINCIPLE_KIND_LABELS[k],
            }))}
            value={kind}
            onChange={(next) => {
              if (next !== null && isKind(next)) setKind(next);
            }}
          />
          <TextInput
            label="Topic key"
            description={keyHint}
            value={shownKey}
            onChange={(e) => {
              setKeyEdited(true);
              setTopicKey(e.currentTarget.value);
            }}
          />
          <TargetSelect project={project} value={target} onChange={setTarget} />
        </Stack>
      </form>
    </FormModal>
  );
}
