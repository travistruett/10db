import {
  KnowledgeItemKind,
  KnowledgeScope,
  PrincipleKind,
  topicKeyFrom,
  type KnowledgeItemDto,
  type KnowledgeTarget,
  type TopicKey,
  type ProjectViewDto,
} from '@10db/contracts';
import { Alert, Button, Group, Radio, Stack, Text, Textarea } from '@mantine/core';
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

/** The record a save would replace, and the fields it was asked about: an edit after it asks again. */
interface Replacing {
  readonly fields: string;
  readonly text: string;
}

const textOf = (record: KnowledgeItemDto): string =>
  record.kind === KnowledgeItemKind.Principle ? record.statement : record.question;

/**
 * New Principle, Edit Principle and Accept Proposal. The topic key is never asked for: a new principle
 * takes it from its statement, and a form that starts from an existing principle or a proposal keeps
 * that one's key. A key decides what a principle replaces, so where the key is not the builder's own
 * record (a new principle, or a proposal an agent keyed), `preview` asks the daemon first, and a save
 * that would replace a current principle names it and waits for Replace. The caller mounts it when the
 * builder opens it, so a form always starts from `initial` or empty.
 */
export function PrincipleDialog({
  project,
  title,
  submitLabel,
  initial,
  pending,
  error,
  preview,
  onSubmit,
  onClose,
}: {
  readonly project: ProjectViewDto;
  readonly title: string;
  readonly submitLabel: string;
  readonly initial?: PrincipleFields;
  readonly pending: boolean;
  readonly error: string | null;
  /** What saving these fields would replace; absent where saving replaces only what the form opened. */
  readonly preview?: (fields: PrincipleFields) => Promise<KnowledgeItemDto | null>;
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
  const [replacing, setReplacing] = useState<Replacing | null>(null);
  const [checking, setChecking] = useState(false);
  const fields: PrincipleFields = {
    target,
    statement: statement.trim(),
    kind,
    topicKey: initial?.topicKey ?? topicKeyFrom(statement),
  };
  const asked = JSON.stringify(fields);
  // A warning about other fields than these says nothing about what saving now would do.
  const shownReplacing = replacing?.fields === asked ? replacing : null;
  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!statement.trim()) {
      setProblem('Write the statement.');
      return;
    }
    setProblem(null);
    if (preview && shownReplacing === null) {
      setChecking(true);
      const replaces = await preview(fields).catch(() => null);
      setChecking(false);
      if (replaces !== null) {
        setReplacing({ fields: asked, text: textOf(replaces) });
        return;
      }
    }
    onSubmit(fields);
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
          <Button type="submit" form={formId} loading={pending || checking}>
            {shownReplacing ? 'Replace' : submitLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          void submit(event);
        }}
        noValidate
      >
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
            label="How agents use it"
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
          {shownReplacing ? (
            <Alert color="yellow" variant="light" title="This replaces a current principle">
              “{shownReplacing.text}” has the same topic at this scope. Saving moves it to Past.
            </Alert>
          ) : null}
        </Stack>
      </form>
    </FormModal>
  );
}
