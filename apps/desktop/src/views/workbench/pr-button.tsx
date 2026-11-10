import {
  PassPullRequestGate,
  PassState,
  type PassPullRequestPreviewDto,
  type PassViewDto,
} from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useOpenPullRequest, usePullRequestPreview } from '../../daemon/pass-close-queries';
import { FormModal } from '../../shell/form-modal';
import { PullRequestLink } from '../board/pull-request-link';

// Workbench spec §5.1, §8.3, W6: Open Pull Request pushes the pass's signed-off pages and opens a
// draft. It reads what it would do first: not offered, it is disabled with the daemon's reason; offered,
// its confirm says the commits from before the pass the pull request will list and where the gate runs.

/** Where the gate runs, in words. */
function gateLine(gate: PassPullRequestGate): string {
  switch (gate) {
    case PassPullRequestGate.Scratch:
      return 'The gate runs on the pushed commit in a separate copy, so you can keep working.';
    case PassPullRequestGate.FolderAtClose:
      return 'The gate runs in your folder when the pass closes.';
    case PassPullRequestGate.None:
      return 'No gate runs for it.';
  }
}

/** "build has 4 commits origin/main lacks…"; null when the pass started on nothing origin lacks. */
function aheadLine(branch: string, preview: PassPullRequestPreviewDto): string | null {
  const ahead = preview.aheadOfBase;
  if (ahead === null || ahead === 0) return null;
  const commits = ahead === 1 ? '1 commit' : `${String(ahead)} commits`;
  return `${branch} has ${commits} origin/${preview.base} lacks from before the pass; the pull request lists them too.`;
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
      title="Open Pull Request"
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
            Open Pull Request
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

/** The element that says why Open Pull Request is disabled, which the button names as its description. */
function reasonId(view: PassViewDto): string {
  return `pull-request-reason-${view.pass.id}`;
}

/**
 * Why Open Pull Request is disabled, as a dimmed line of its own under the header's row: beside the
 * button it would crowd the pass's line out of a narrow window.
 */
export function PrReason({ view }: { readonly view: PassViewDto }) {
  const { why } = usePullRequestRefusal(view);
  if (why === null) return null;
  return (
    <Text id={reasonId(view)} size="xs" c="dimmed">
      {why}
    </Text>
  );
}

/** Open Pull Request in the pass's header, with the pull request's link once it has one. */
export function PrButton({ view }: { readonly view: PassViewDto }) {
  const { preview, why } = usePullRequestRefusal(view);
  const [confirming, setConfirming] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);
  const shown = preview.data;
  const url = view.pullRequest?.url ?? posted ?? shown?.existing?.url ?? null;
  return (
    <Group gap="xs" wrap="nowrap">
      {url === null ? null : <PullRequestLink url={url} />}
      <Button
        {...(why === null ? {} : { 'aria-describedby': reasonId(view) })}
        variant="default"
        size="xs"
        loading={preview.isLoading}
        disabled={view.pass.state !== PassState.Open || shown?.offered !== true}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Open Pull Request
      </Button>
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
