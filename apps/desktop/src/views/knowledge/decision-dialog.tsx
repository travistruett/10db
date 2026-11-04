import { KnowledgeScope, type KnowledgeTarget, type ProjectViewDto } from '@10db/contracts';
import { Button, Stack, Textarea, TextInput } from '@mantine/core';
import { useId, useState, type SyntheticEvent } from 'react';
import { FormModal } from '../../shell/form-modal';
import { TargetSelect } from './target-select';

export interface DecisionFields {
  readonly target: KnowledgeTarget;
  readonly question: string;
  readonly choice: string;
  readonly rationale: string;
}

/**
 * New Decision and Edit Decision. The caller mounts it when the builder opens it, so a form always
 * starts from `initial` (an edit) or empty (a new one).
 */
export function DecisionDialog({
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
  readonly initial?: DecisionFields;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (fields: DecisionFields) => void;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const [question, setQuestion] = useState(initial?.question ?? '');
  const [choice, setChoice] = useState(initial?.choice ?? '');
  const [rationale, setRationale] = useState(initial?.rationale ?? '');
  const [target, setTarget] = useState<KnowledgeTarget>(
    initial?.target ?? { scope: KnowledgeScope.Project, projectId: project.id },
  );
  const [missing, setMissing] = useState(false);
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const fields = {
      question: question.trim(),
      choice: choice.trim(),
      rationale: rationale.trim(),
    };
    if (!fields.question || !fields.choice || !fields.rationale) {
      setMissing(true);
      return;
    }
    setMissing(false);
    onSubmit({ target, ...fields });
  };
  return (
    <FormModal
      opened
      onClose={onClose}
      title={title}
      size="md"
      error={missing ? 'Fill in the question, the choice and the rationale.' : error}
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
          <TextInput
            label="Question"
            data-autofocus
            value={question}
            onChange={(e) => {
              setQuestion(e.currentTarget.value);
            }}
          />
          <TextInput
            label="Choice"
            value={choice}
            onChange={(e) => {
              setChoice(e.currentTarget.value);
            }}
          />
          <Textarea
            label="Rationale"
            autosize
            minRows={2}
            value={rationale}
            onChange={(e) => {
              setRationale(e.currentTarget.value);
            }}
          />
          <TargetSelect project={project} value={target} onChange={setTarget} />
        </Stack>
      </form>
    </FormModal>
  );
}
