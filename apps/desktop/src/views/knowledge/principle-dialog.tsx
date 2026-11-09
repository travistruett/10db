import {
  KnowledgeScope,
  PrincipleKind,
  topicKeyFrom,
  type TopicKey,
  type KnowledgeTarget,
  type ProjectViewDto,
} from '@10db/contracts';
import { Button, Group, Radio, Stack, Text, Textarea } from '@mantine/core';
import { useId, useState, type SyntheticEvent } from 'react';
import { FormModal } from '../../shell/form-modal';
import { PRINCIPLE_KIND_DESCRIPTIONS, PRINCIPLE_KIND_LABELS } from './knowledge-labels';
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
 * New Principle, Edit Principle and Accept Proposal. The topic key is never asked for: a new principle
 * takes it from its statement, and a form that starts from an existing principle or a proposal keeps
 * that one's key, so saving replaces what it started from. The caller mounts it when the builder opens
 * it, so a form always starts from `initial` or empty.
 */
export function PrincipleDialog({
  project,
  title,
  submitLabel,
  initial,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  readonly project: ProjectViewDto;
  readonly title: string;
  readonly submitLabel: string;
  readonly initial?: PrincipleFields;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (fields: PrincipleFields) => void;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const [statement, setStatement] = useState(initial?.statement ?? '');
  const [kind, setKind] = useState<PrincipleKind>(initial?.kind ?? PrincipleKind.Heuristic);
  const [target, setTarget] = useState<KnowledgeTarget>(
    initial?.target ?? { scope: KnowledgeScope.Project, projectId: project.id },
  );
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!statement.trim()) {
      setProblem('Write the statement.');
      return;
    }
    setProblem(null);
    onSubmit({
      target,
      statement: statement.trim(),
      kind,
      topicKey: initial?.topicKey ?? topicKeyFrom(statement),
    });
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
          <Radio.Group
            label="Kind"
            value={kind}
            onChange={(next) => {
              if (isKind(next)) setKind(next);
            }}
          >
            <Stack gap="xs" mt={4}>
              {Object.values(PrincipleKind).map((k) => (
                <Radio.Card key={k} value={k} radius="md" p="sm">
                  <Group wrap="nowrap" align="flex-start" gap="sm">
                    <Radio.Indicator mt={2} />
                    <div>
                      <Text size="sm" fw={500}>
                        {PRINCIPLE_KIND_LABELS[k]}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {PRINCIPLE_KIND_DESCRIPTIONS[k]}
                      </Text>
                    </div>
                  </Group>
                </Radio.Card>
              ))}
            </Stack>
          </Radio.Group>
          <TargetSelect project={project} value={target} onChange={setTarget} />
        </Stack>
      </form>
    </FormModal>
  );
}
