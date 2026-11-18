import { ChatGitStep, type ChatId, type ChatWorkStateDto } from '@10db/contracts';
import { Button, Tooltip } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { useChatChanges } from '../../daemon/chat-changes-queries';
import { useCommitChat, useMergeChat, useOpenPullRequestChat } from '../../daemon/chat-git-queries';
import { CommitModal } from './commit-modal';
import { commitFiles } from './commit-paths';
import { checksWords } from './session-meta';

export interface GitStepButtonProps {
  readonly chatId: ChatId;
  readonly state: ChatWorkStateDto;
  /** The session's title, which starts the commit message. */
  readonly title: string;
  /** The session's own turn is running: a step then waits for it to end. */
  readonly turnRunning: boolean;
  /** A step failed; the screen shows it as a notification. */
  readonly onError: (message: string) => void;
}

/** Why Merge cannot run yet, in the few words the button wears, or null when it can. */
function mergeBlocked(state: ChatWorkStateDto): string | null {
  const pr = state.pullRequest;
  if (pr === null) return null;
  const checks = checksWords(pr.checks);
  if (checks !== 'checks passing') return `${checks.charAt(0).toUpperCase()}${checks.slice(1)}`;
  if (pr.mergeable === false) return 'Needs a merge from the base branch';
  return null;
}

/**
 * The title row's next git step (sessions spec §4.6): one button, whichever step the daemon says is next.
 * Commit… asks for a message and files; the rest run at once. While this session's own turn runs a step
 * waits for it, and says so.
 */
export function GitStepButton({
  chatId,
  state,
  title,
  turnRunning,
  onError,
}: GitStepButtonProps): ReactNode {
  const [committing, setCommitting] = useState(false);
  const commit = useCommitChat();
  const openPullRequest = useOpenPullRequestChat();
  const merge = useMergeChat();
  const changes = useChatChanges(chatId, committing);
  const step = state.next;
  // The form stays while it is being filled even if the daemon's next step moves on under it.
  if (step === null && !committing) return null;

  const pending = commit.isPending || openPullRequest.isPending || merge.isPending;
  const fail = (error: Error): void => {
    onError(error.message);
  };
  const base = state.baseBranch ?? 'the base branch';

  const waitsForTurn = pending && turnRunning;
  const label = (() => {
    if (waitsForTurn) return 'Waits for the turn to end';
    switch (step) {
      case null:
        return '';
      case ChatGitStep.Commit:
        return 'Commit…';
      case ChatGitStep.OpenPullRequest:
        // With a pull request already open the step only pushes the new commits to it.
        return state.pullRequest === null ? 'Open Pull Request' : 'Push';
      case ChatGitStep.Merge:
        return 'Merge';
      case ChatGitStep.MergeLocal:
        return `Merge into ${base}`;
    }
  })();
  const blocked = state.refusal ?? (step === ChatGitStep.Merge ? mergeBlocked(state) : null);
  const shown = blocked !== null && !pending ? blocked : label;

  const run = (): void => {
    switch (step) {
      case null:
        return;
      case ChatGitStep.Commit:
        setCommitting(true);
        return;
      case ChatGitStep.OpenPullRequest:
        openPullRequest.mutate(chatId, { onError: fail });
        return;
      case ChatGitStep.Merge:
      case ChatGitStep.MergeLocal:
        merge.mutate(chatId, { onError: fail });
        return;
    }
  };

  const changed = changes.data?.files.map((file) => file.path) ?? [];
  const { files, checked } = commitFiles(changed, state.touched);
  return (
    <>
      {step === null ? null : (
        <Tooltip label={blocked} disabled={blocked === null || pending} openDelay={300}>
          <Button
            size="compact-sm"
            variant={step === ChatGitStep.Commit ? 'default' : 'filled'}
            // A disabled button is not a tooltip's target, so the reason is also its name.
            disabled={blocked !== null || pending}
            loading={pending && !turnRunning}
            onClick={run}
          >
            {shown}
          </Button>
        </Tooltip>
      )}
      {step === ChatGitStep.Commit || committing ? (
        <CommitModal
          key={committing ? 'open' : 'closed'}
          opened={committing}
          onClose={() => {
            setCommitting(false);
            commit.reset();
          }}
          defaultMessage={title}
          files={files}
          checked={checked}
          loading={changes.isPending}
          pending={commit.isPending}
          waitsForTurn={commit.isPending && turnRunning}
          error={commit.error?.message ?? null}
          onCommit={(message, paths) => {
            commit.mutate(
              { chatId, message, paths: [...paths] },
              {
                onSuccess: () => {
                  setCommitting(false);
                },
              },
            );
          }}
        />
      ) : null}
    </>
  );
}
