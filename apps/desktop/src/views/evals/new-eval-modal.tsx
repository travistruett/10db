import {
  NewEvalOrigin,
  type NewEvalBody,
  type PlanEval,
  type ProjectId,
  type TaskDto,
} from '@10db/contracts';
import { Anchor, Button, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { useNewEvalTask } from '../../daemon/evals-queries';
import { FormModal } from '../../shell/form-modal';

/** What the form opens with, from where New Eval was pressed. */
export interface NewEvalPrefill {
  readonly behavior?: string;
  readonly decision?: string;
  readonly evidence?: string;
  readonly oracle?: string;
  readonly coverageAndBar?: string;
  readonly models?: string;
  readonly where?: readonly string[];
  readonly origin: NewEvalOrigin;
}

/** The longest behavior the task's title takes (`NewEvalRequest`). */
const BEHAVIOR_MAX = 150;

/** One line cut to what a title takes, so a long objective or gap label still files. */
export const asBehavior = (text: string): string =>
  text.replaceAll(/\s+/gu, ' ').trim().slice(0, BEHAVIOR_MAX);

/** A goal's proposed eval as the form's start: its objective is the behavior, its baseline the bar. */
export function prefillFromPlanEval(plan: PlanEval): NewEvalPrefill {
  return {
    behavior: asBehavior(plan.objective),
    ...(plan.decision === undefined ? {} : { decision: plan.decision }),
    ...(plan.oracle === undefined ? {} : { oracle: plan.oracle }),
    coverageAndBar: plan.baseline.join('\n'),
    models: plan.models.join(', '),
    origin: NewEvalOrigin.PlanEval,
  };
}

const FORM_ID = 'new-eval-form';

const SECTIONS = [
  ['decision', 'Decision', 'What this eval helps you decide, such as which model to ship.'],
  ['evidence', 'Evidence', 'Where the behavior has gone wrong or been measured before.'],
  ['oracle', 'Oracle', 'What counts as the right answer, and who or what grades it.'],
  ['coverageAndBar', 'Coverage and Bar', 'The cases to cover and the bar a model must reach.'],
  ['models', 'Models', 'The models to compare.'],
  ['execution', 'Execution', 'How it runs: the free arm in the gate, the paid arm by hand.'],
] as const;

type SectionKey = (typeof SECTIONS)[number][0];

function Form({
  projectId,
  prefill,
  onClose,
  onFiled,
}: {
  readonly projectId: ProjectId;
  readonly prefill: NewEvalPrefill;
  readonly onClose: () => void;
  readonly onFiled: (task: TaskDto) => void;
}) {
  const file = useNewEvalTask(projectId);
  const [behavior, setBehavior] = useState(prefill.behavior ?? '');
  const [sections, setSections] = useState<Record<SectionKey, string>>({
    decision: prefill.decision ?? '',
    evidence: prefill.evidence ?? '',
    oracle: prefill.oracle ?? '',
    coverageAndBar: prefill.coverageAndBar ?? '',
    models: prefill.models ?? '',
    execution: '',
  });
  const [refusal, setRefusal] = useState<string | null>(null);
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (behavior.trim() === '') {
      setRefusal('Name the behavior the eval is for');
      return;
    }
    setRefusal(null);
    const request: NewEvalBody = {
      behavior: behavior.trim(),
      ...sections,
      where: [...(prefill.where ?? [])],
      origin: prefill.origin,
    };
    file.mutate(request, { onSuccess: onFiled });
  };
  return (
    <FormModalBody
      onClose={onClose}
      pending={file.isPending}
      error={refusal ?? file.error?.message ?? null}
    >
      <form id={FORM_ID} onSubmit={submit} noValidate>
        <Stack>
          <TextInput
            label="Behavior"
            maxLength={BEHAVIOR_MAX}
            description="The task is titled Write the eval for this."
            value={behavior}
            onChange={(e) => {
              setBehavior(e.currentTarget.value);
            }}
          />
          {SECTIONS.map(([key, label, hint]) => (
            <Textarea
              key={key}
              label={label}
              description={hint}
              autosize
              minRows={1}
              maxRows={6}
              value={sections[key]}
              onChange={(e) => {
                const text = e.currentTarget.value;
                setSections((now) => ({ ...now, [key]: text }));
              }}
            />
          ))}
          {prefill.where === undefined || prefill.where.length === 0 ? null : (
            <Text size="sm" c="dimmed">
              {`The lane reads ${prefill.where.join(', ')}.`}
            </Text>
          )}
        </Stack>
      </form>
    </FormModalBody>
  );
}

/** The modal's frame while the form is open: Cancel and Create Task, the error beside them. */
function FormModalBody({
  onClose,
  pending,
  error,
  children,
}: {
  readonly onClose: () => void;
  readonly pending: boolean;
  readonly error: string | null;
  readonly children: ReactNode;
}) {
  return (
    <FormModal
      opened
      onClose={onClose}
      title="New Eval"
      error={error}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} loading={pending}>
            File Task
          </Button>
        </>
      }
    >
      {children}
    </FormModal>
  );
}

/**
 * New Eval: a short form that files a task, "Write the eval for <behavior>", whose brief is the rationale.
 * The lane drafts the cases and graders by the project's own eval skill and never runs the live arm.
 */
export function NewEvalModal({
  projectId,
  prefill,
  onClose,
}: {
  readonly projectId: ProjectId;
  /** Null while closed. */
  readonly prefill: NewEvalPrefill | null;
  readonly onClose: () => void;
}) {
  const [filed, setFiled] = useState<TaskDto | null>(null);
  const close = (): void => {
    setFiled(null);
    onClose();
  };
  if (prefill === null) return null;
  if (filed !== null)
    return (
      <FormModal
        opened
        onClose={close}
        title="New Eval"
        actions={<Button onClick={close}>Done</Button>}
      >
        <Text size="sm">
          Filed{' '}
          <Anchor
            onClick={close}
            renderRoot={(props) => <Link {...props} to="/board" search={{ task: filed.id }} />}
          >
            {filed.title}
          </Anchor>
          . A lane drafts the cases and never runs the live arm.
        </Text>
      </FormModal>
    );
  return <Form projectId={projectId} prefill={prefill} onClose={close} onFiled={setFiled} />;
}
