import {
  PassPullRequestGate,
  PassState,
  type PassPullRequestPreviewDto,
  type PassViewDto,
} from '@10db/contracts';
import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useOpenPullRequest, usePullRequestPreview } from '../../daemon/pass-close-queries';
import { ExternalLink } from '../board/pull-request-link';
import { FormModal } from '../../shell/form-modal';

// Workbench spec §5.1, §8.3, W6: Open Draft PR pushes the pass's signed-off pages and opens a draft;
// once the pull request exists the same button reads Push to PR. It reads what it would do first: not
// offered, no button is drawn, and the signed-off page's foot (`PrFoot`) says the daemon's reason.
// Pushing is easy to undo, so it asks nothing first, except when the branch carries commits from before
// the pass, which the pull request would list too.

/** Where the gate runs, in words. */
function gateLine(gate: PassPullRequestGate): string {
  switch (gate) {
    case PassPullRequestGate.Scratch:
      return 'The gate runs on the pushed commit in a separate copy, so you can keep working.';
    case PassPullRequestGate.FolderAtClose:
      return 'The gate runs in your folder when you finish.';
    case PassPullRequestGate.None:
      return 'No gate runs for it.';
  }
}

/** "build has 4 commits origin/main lacks…"; null when the pass started on nothing origin lacks. */
function aheadLine(branch: string, preview: PassPullRequestPreviewDto): string | null {
  const ahead = preview.aheadOfBase;
  if (ahead === null || ahead === 0) return null;
  const commits = ahead === 1 ? '1 commit' : `${String(ahead)} commits`;
  return `${branch} has ${commits} origin/${preview.base} lacks from before you started; the pull request lists them too.`;
}

interface ConfirmProps {
  readonly view: PassViewDto;
  readonly preview: PassPullRequestPreviewDto;
  readonly onClose: () => void;
  readonly onOpened: (url: string | null) => void;
}

function OpenPullRequestConfirm({ view, preview, onClose, onOpened }: ConfirmProps) {
  const opening = useOpenPullRequest();
  const ahead = aheadLine(view.pass.returnBranch, preview);
  return (
    <FormModal
      opened
      onClose={onClose}
      title={preview.existing === null ? 'Open Draft PR' : 'Push to PR'}
      size="md"
      error={opening.error?.message ?? null}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={opening.isPending}
            onClick={() => {
              // From the promise, not mutate's own onSuccess, which is dropped if a preview read
              // after the open stops offering it and this confirm unmounts first.
              opening
                .mutateAsync(view.pass.id)
                .then((opened) => {
                  onOpened(opened.url);
                  onClose();
                })
                .catch(() => {
                  // The failure is said from `opening.error`.
                });
            }}
          >
            {preview.existing === null ? 'Open Draft PR' : 'Push to PR'}
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        <Text size="sm">
          {preview.existing === null
            ? `Push the signed-off pages and open a draft pull request against ${preview.base}?`
            : `Push the signed-off pages to the pull request already open against ${preview.base}?`}
        </Text>
        {ahead === null ? null : <Text size="sm">{ahead}</Text>}
        <Text size="sm" c="dimmed">
          {gateLine(preview.gate)}
        </Text>
      </Stack>
    </FormModal>
  );
}

/** Why Open Pull Request is not offered, read from its preview; null while it is or is not read yet. */
function usePullRequestRefusal(view: PassViewDto) {
  const preview = usePullRequestPreview(view);
  const shown = preview.data;
  return {
    preview,
    why: preview.error?.message ?? (shown?.offered === false ? shown.reason : null),
  };
}

/**
 * The signed-off page's foot line: what happens next, or, while no pull request can be opened, why not.
 * The panel and the header show no pull request control then, so this is where the reason is said.
 */
export function PrFoot({ view }: { readonly view: PassViewDto }) {
  const { preview, why } = usePullRequestRefusal(view);
  // Until the first preview answers, the line would say one thing and then another, so it waits.
  if (preview.data === undefined && preview.error === null) return null;
  const exists = (view.pullRequest ?? preview.data?.existing ?? null) !== null;
  const line =
    why === null
      ? 'Committed. CI checks it once it is in the pull request.'
      : exists
        ? `Committed. It can't be pushed to the pull request yet: ${why}`
        : `Committed. No pull request yet: ${why}`;
  return (
    <>
      <Text size="sm" c="dimmed">
        {line}
      </Text>
      <PrButton view={view} />
    </>
  );
}

/** "PR #633"; the address itself when it names no number. */
function prName(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number === undefined ? 'Pull request' : `PR #${number}`;
}

/** The gate on the pushed tip, in a word or two; null before anything was pushed. */
function gateWord(view: PassViewDto): { readonly text: string; readonly color: string } | null {
  switch (view.checks.gate.state) {
    case 'running':
      return { text: 'Checks running', color: 'blue' };
    case 'passed':
      return { text: 'Checks passed', color: 'green' };
    case 'failed':
      return { text: 'Checks failed', color: 'red' };
    case 'not_run':
      return null;
  }
}

/**
 * The pass's pull request in its header: Open Draft PR until there is one, then its name, whether it is
 * a draft, where its checks are, and Push to PR for what was signed off since. A button the daemon does not
 * offer is not drawn (`PrFoot` says why), so with no pull request and nothing to open the control is gone.
 */
export function PrButton({
  view,
  inset = false,
}: {
  readonly view: PassViewDto;
  /** Padded to the panel's head, where it sits on a line of its own. */
  readonly inset?: boolean;
}) {
  const { preview } = usePullRequestRefusal(view);
  const opening = useOpenPullRequest();
  const [confirming, setConfirming] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);
  const shown = preview.data;
  const url = view.pullRequest?.url ?? posted ?? shown?.existing?.url ?? null;
  const draft = view.pullRequest?.draft ?? shown?.existing?.draft ?? null;
  const gate = url === null ? null : gateWord(view);
  const offered = view.pass.state === PassState.Open && shown?.offered === true;
  if (url === null && !offered && opening.error === null) return null;
  const push = () => {
    opening
      .mutateAsync(view.pass.id)
      .then((opened) => {
        setPosted(opened.url);
      })
      .catch(() => {
        // The failure is said from `opening.error`.
      });
  };
  return (
    <Group gap="xs" wrap="nowrap" {...(inset ? { px: 'sm', pb: 'xs' } : {})}>
      {url === null ? null : (
        <Group gap={6} wrap="nowrap">
          <ExternalLink url={url} label={prName(url)} />
          {draft === true ? (
            <Badge size="sm" variant="light" color="gray">
              Draft
            </Badge>
          ) : null}
          {gate === null ? null : (
            <Badge size="sm" variant="light" color={gate.color}>
              {gate.text}
            </Badge>
          )}
        </Group>
      )}
      {opening.error === null ? null : (
        <Text size="xs" c="red" role="alert">
          {opening.error.message}
        </Text>
      )}
      {offered ? (
        <Button
          variant={url === null ? 'filled' : 'default'}
          size="xs"
          loading={opening.isPending}
          onClick={() => {
            if (aheadLine(view.pass.returnBranch, shown) === null) push();
            else setConfirming(true);
          }}
        >
          {url === null ? 'Open Draft PR' : 'Push to PR'}
        </Button>
      ) : null}
      {confirming && shown?.offered === true ? (
        <OpenPullRequestConfirm
          view={view}
          preview={shown}
          onClose={() => {
            setConfirming(false);
          }}
          onOpened={setPosted}
        />
      ) : null}
    </Group>
  );
}
