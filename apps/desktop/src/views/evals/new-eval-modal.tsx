import { NewEvalOrigin, type PlanEval, type ProjectId, type TaskDto } from '@10db/contracts';
import { Anchor, Button, Stepper, Text, Tooltip } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useNewEvalTask } from '../../daemon/evals-queries';
import { useModels } from '../../daemon/model-queries';
import { useProjects } from '../../daemon/queries';
import { FormModal } from '../../shell/form-modal';
import {
  asBehavior,
  asGoal,
  firstProblem,
  initialDraft,
  stepProblem,
  toRequest,
  WizardStep,
  type EvalDraft,
  type NewEvalPrefill,
} from './new-eval-draft';
import { useSuggestions } from './new-eval-suggest';
import { CheckingStep, ExamplesStep, GoalStep, ModelsStep, ReviewStep } from './new-eval-steps';

export { asBehavior, type NewEvalPrefill };

/** A goal's proposed eval as the wizard's start: its objective is the sentence, its baseline the bar. */
export function prefillFromPlanEval(plan: PlanEval): NewEvalPrefill {
  return {
    behavior: asBehavior(plan.objective),
    goal: asGoal(plan.objective),
    ...(plan.decision === undefined ? {} : { decision: plan.decision }),
    ...(plan.oracle === undefined ? {} : { oracle: plan.oracle }),
    coverageAndBar: plan.baseline.join('\n'),
    models: plan.models.join(', '),
    origin: NewEvalOrigin.PlanEval,
  };
}

const STEPS = [
  ['Goal', WizardStep.Goal],
  ['Examples', WizardStep.Examples],
  ['Checking', WizardStep.Checking],
  ['Models', WizardStep.Models],
  ['Review', WizardStep.Review],
] as const;

const LAST_STEP = WizardStep.Review;

/** The steps and the footer of one New Eval; its state is the draft, kept while the builder goes back. */
function Wizard({
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
  const projects = useProjects();
  const accountId = projects.data?.find((p) => p.id === projectId)?.accountId ?? null;
  const models = useModels(accountId, accountId !== null);
  const suggestions = useSuggestions(projectId, prefill.where ?? []);
  const [draft, setDraft] = useState<EvalDraft>(() => initialDraft(prefill));
  const [step, setStep] = useState<WizardStep>(WizardStep.Goal);
  const [reached, setReached] = useState<WizardStep>(WizardStep.Goal);
  const change = (patch: Partial<EvalDraft>): void => {
    setDraft((now) => ({ ...now, ...patch }));
  };
  const earlier = firstProblem(draft);
  // On Review every step is checked again, since an earlier one may have been changed since it passed.
  const problem =
    step === LAST_STEP && earlier !== null
      ? `Back on ${STEPS[earlier.step][0]}: ${earlier.problem}`
      : stepProblem(step, draft);
  const goTo = (next: WizardStep): void => {
    setStep(next);
    setReached((now) => (next > now ? next : now));
  };
  const modelRows = models.data ?? [];
  const onAccount = modelRows.filter(
    (m) => accountId !== null && m.availableOn.includes(accountId),
  );
  // A model the project's account can't reach is still a fair id to compare, but the list leads with what it can.
  const listed = (onAccount.length > 0 ? onAccount : modelRows)
    .slice()
    .sort((a, b) => (b.intelligence ?? -1) - (a.intelligence ?? -1));
  const stepProps = { draft, change };
  const body = (() => {
    switch (step) {
      case WizardStep.Goal:
        return <GoalStep {...stepProps} suggestions={suggestions} />;
      case WizardStep.Examples:
        return <ExamplesStep {...stepProps} suggestions={suggestions} />;
      case WizardStep.Checking:
        return <CheckingStep {...stepProps} suggestions={suggestions} />;
      case WizardStep.Models:
        return <ModelsStep {...stepProps} models={listed} />;
      case WizardStep.Review:
        return <ReviewStep draft={draft} prefill={prefill} models={modelRows} />;
    }
  })();
  const last = step === LAST_STEP;
  return (
    <FormModal
      opened
      onClose={onClose}
      title="New Eval"
      size={640}
      error={file.error?.message ?? null}
      actions={
        <>
          {step === WizardStep.Goal ? null : (
            <Button
              variant="default"
              onClick={() => {
                goTo(STEPS[step - 1]?.[1] ?? step);
              }}
            >
              Back
            </Button>
          )}
          <Tooltip label={problem} disabled={problem === null} withArrow>
            <span>
              {last ? (
                <Button
                  disabled={problem !== null}
                  loading={file.isPending}
                  onClick={() => {
                    file.mutate(toRequest(draft, prefill), { onSuccess: onFiled });
                  }}
                >
                  Create Task
                </Button>
              ) : (
                <Button
                  disabled={problem !== null}
                  onClick={() => {
                    goTo(STEPS[step + 1]?.[1] ?? step);
                  }}
                >
                  Next
                </Button>
              )}
            </span>
          </Tooltip>
        </>
      }
    >
      <Stepper
        active={step}
        size="sm"
        iconSize={26}
        allowNextStepsSelect={false}
        onStepClick={(next) => {
          const target = STEPS[next]?.[1];
          // A step opens only when every step before it still holds.
          const open = STEPS.every(([, s]) => s >= (target ?? 0) || stepProblem(s, draft) === null);
          if (target !== undefined && target <= reached && open) setStep(target);
        }}
        mb="md"
      >
        {STEPS.map(([label]) => (
          <Stepper.Step key={label} label={label} />
        ))}
      </Stepper>
      {body}
      {problem === null ? null : (
        <Text size="xs" c="dimmed" mt="md">
          {problem}
        </Text>
      )}
      {suggestions.unavailableNote === null ? null : (
        <Text size="xs" c="dimmed" mt="xs">
          {suggestions.unavailableNote}
        </Text>
      )}
      {suggestions.problem === null ? null : (
        <Text size="xs" c="red" mt="xs">
          {suggestions.problem}
        </Text>
      )}
    </FormModal>
  );
}

/**
 * New Eval: a short stepper that asks, in plain words, what good looks like, for real examples, how to
 * check them and which models to try, then files a task whose brief is the answers. The agent that takes the
 * task writes the cases and checks by the project's own eval skill and never runs a paid model.
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
        size={640}
        actions={<Button onClick={close}>Done</Button>}
      >
        <Text size="sm">
          Task created:{' '}
          <Anchor
            onClick={close}
            renderRoot={(props) => <Link {...props} to="/board" search={{ task: filed.id }} />}
          >
            {filed.title}
          </Anchor>
          . An agent writes the cases and checks; it never runs paid models on its own.
        </Text>
      </FormModal>
    );
  return <Wizard projectId={projectId} prefill={prefill} onClose={close} onFiled={setFiled} />;
}
