import type { EvalSuggestRequest, EvalSuggestResult, ProjectId } from '@10db/contracts';
import { Button } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useState } from 'react';
import { useEvalSuggest, useEvalSuggestStatus } from '../../daemon/eval-suggest-queries';

/** The part of a suggestion the wizard reads: what the model proposed, by what was asked. */
export type SuggestedAnswer = Extract<EvalSuggestResult, { ok: true }>['answer'];

type WithoutWhere<T> = T extends unknown ? Omit<T, 'where'> : never;

/** A question as a step asks it; the wizard adds the paths the behavior lives in. */
export type SuggestAsk = (
  request: WithoutWhere<EvalSuggestRequest>,
) => Promise<SuggestedAnswer | null>;

export interface Suggestions {
  /** False until the daemon says there is a model to ask, and for good once it says there is none. */
  readonly available: boolean;
  /** Why there are no suggestions, as one dim line; null when there are, or while it is not yet known. */
  readonly unavailableNote: string | null;
  readonly busy: boolean;
  /** Why the last question gave nothing; null after a good answer. */
  readonly problem: string | null;
  readonly ask: SuggestAsk;
}

/** The wizard's suggest buttons: whether a model can be asked, and one question to it at a time. */
export function useSuggestions(projectId: ProjectId, where: readonly string[]): Suggestions {
  const status = useEvalSuggestStatus(projectId);
  const mutation = useEvalSuggest(projectId);
  const [gone, setGone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ask: SuggestAsk = async (request) => {
    setProblem(null);
    try {
      const result = await mutation.mutateAsync({ ...request, where: [...where] });
      if (result.ok) return result.answer;
      if (result.unavailable) setGone(result.message);
      else setProblem(result.message);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "10db couldn't get a suggestion.");
    }
    return null;
  };
  const reason = status.data?.available === false ? status.data.reason : null;
  const note = gone ?? reason;
  return {
    available: status.data?.available === true && gone === null,
    unavailableNote: note,
    busy: mutation.isPending,
    problem,
    ask,
  };
}

/** A suggest button; a step shows it only while `Suggestions.available`. */
export function SuggestButton({
  label,
  busy,
  disabled = false,
  onClick,
}: {
  readonly label: string;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button
      size="xs"
      variant="light"
      leftSection={<IconSparkles size={14} />}
      loading={busy}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
