import { EvalAssessmentState, type EvalAssessmentDto, type ProjectViewDto } from '@10db/contracts';
import { Button } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconCopy, IconSparkles } from '@tabler/icons-react';
import { useAssessEvals } from '../../daemon/evals-queries';

/** What to paste in a Claude Code or Codex session to have it assess the project's evals itself. */
function assessAsk(project: ProjectViewDto): string {
  return `Use the 10db-task skill to assess the evals of the 10db project ${project.name} (${project.id}).`;
}

export interface EvalAssessment {
  /** An assessment is running, started here or by 10db itself. */
  readonly busy: boolean;
  /** 10db has no model it can ask for this project, so the builder's own session does it. */
  readonly unavailable: boolean;
  /** Why the last assessment gave nothing; null while it hasn't failed. */
  readonly failure: string | null;
  readonly run: () => void;
}

export function useEvalAssessment(assessment: EvalAssessmentDto, projectId: ProjectViewDto['id']) {
  const assess = useAssessEvals(projectId);
  return {
    busy: assess.isPending || assessment.state === EvalAssessmentState.Assessing,
    unavailable: assessment.state === EvalAssessmentState.Unavailable,
    failure: assessment.state === EvalAssessmentState.Failed ? assessment.reason : null,
    run: () => {
      assess.mutate();
    },
  } satisfies EvalAssessment;
}

/**
 * The one way to have the evals assessed: Assess now, busy while it runs. Where 10db can't ask a model for this
 * project it offers the prompt to paste in the builder's own session instead.
 */
export function AssessAction({
  assessment,
  project,
  variant = 'default',
}: {
  readonly assessment: EvalAssessment;
  readonly project: ProjectViewDto;
  readonly variant?: 'default' | 'light';
}) {
  const clipboard = useClipboard({ timeout: 1500 });
  if (assessment.unavailable) {
    return (
      <Button
        size="xs"
        variant={variant}
        leftSection={<IconCopy size={14} stroke={1.5} />}
        onClick={() => {
          clipboard.copy(assessAsk(project));
        }}
      >
        {clipboard.copied ? 'Copied' : 'Copy a prompt for your own session'}
      </Button>
    );
  }
  return (
    <Button
      size="xs"
      variant={variant}
      loading={assessment.busy}
      leftSection={<IconSparkles size={14} stroke={1.5} />}
      onClick={assessment.run}
    >
      Assess now
    </Button>
  );
}
