import {
  PassNoticeKind,
  PassPullRequestGate,
  PassState,
  type PassPullRequestPreviewDto,
  type PassViewDto,
} from '@10db/contracts';
import { ActionIcon, Badge, Button, Group, Menu, Stack, Text } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { useOpenPullRequest, usePullRequestPreview } from '../../daemon/pass-close-queries';
import { ExternalLink } from '../board/pull-request-link';
import { FormModal } from '../../shell/form-modal';
import { MenuAction } from './menu-action';

// Workbench spec §5.1, §8.3, W6: Open PR pushes the pass's committed pages and opens the pull request,
// ready for review, with Open as Draft in its menu. Once it exists, each page committed is pushed to it
// by the daemon, and the control is the pull request's name, its state and a menu holding Mark Ready
// for Review (a draft) and Push Now (a push that failed). It reads what it would do first: not offered,
// no button is drawn, and the committed page's foot (`PrFoot`) says the daemon's reason. Pushing is
// easy to undo, so it asks nothing first, except when the branch carries commits from before the
// pass, which the pull request would list too.

/** The branch a pass lands on at its close, where it has no pull request to merge; else null. */
export function useMergeTo(view: PassViewDto): string | null {
  const lands = usePullRequestPreview(view).data?.lands;
  return lands === 'close' ? view.pass.returnBranch : null;
}

/** Where the gate runs, in words. */
function gateLine(gate: PassPullRequestGate): string {
  switch (gate) {
    case PassPullRequestGate.Scratch:
      return 'The gate runs on the pushed commit in a separate copy, so you can keep working.';
    case PassPullRequestGate.FolderAtClose:
      return 'The gate runs in your folder when you merge.';
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
  /** Ready for review, else a draft. */
  readonly ready: boolean;
  readonly onClose: () => void;
  readonly onOpened: (url: string | null) => void;
}

function OpenPullRequestConfirm({ view, preview, ready, onClose, onOpened }: ConfirmProps) {
  const opening = useOpenPullRequest();
  const ahead = aheadLine(view.pass.returnBranch, preview);
  const label = ready ? 'Open PR' : 'Open as Draft';
  return (
    <FormModal
      opened
      onClose={onClose}
      title={label}
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
                .mutateAsync({ passId: view.pass.id, ready })
                .then((opened) => {
                  onOpened(opened.url);
                  onClose();
                })
                .catch(() => {
                  // The failure is said from `opening.error`.
                });
            }}
          >
            {label}
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        <Text size="sm">
          {ready
            ? `Push the committed pages and open a pull request against ${preview.base}?`
            : `Push the committed pages and open a draft pull request against ${preview.base}?`}
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
      ? exists
        ? 'Committed. It goes to the pull request, where CI checks it.'
        : 'Committed. Open PR when you are ready; CI checks it there.'
      : exists
        ? `Committed. It can't be pushed to the pull request yet: ${why}`
        : `Committed. ${why.replace(/\.$/, '')}.`;
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
  return number === undefined ? 'Pull Request' : `PR #${number}`;
}

/** The gate on the pushed tip, in a word or two; null before anything was pushed. */
function gateWord(view: PassViewDto): { readonly text: string; readonly color: string } | null {
  switch (view.checks.gate.state) {
    case 'running':
      return { text: 'Checks Running', color: 'blue' };
    case 'passed':
      return { text: 'Checks Passed', color: 'green' };
    case 'failed':
      return { text: 'Checks Failed', color: 'red' };
    case 'not_run':
      return null;
  }
}

/**
 * The pass's pull request in its header: Open PR (Open as Draft in its menu) until there is one, then
 * its name, whether it is a draft, where its checks are, and a menu with Mark Ready for Review for a
 * draft and Push Now once a push failed. A button the daemon does not offer is not drawn (`PrFoot` says
 * why), so with no pull request and nothing to open the control is gone.
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
  const [confirming, setConfirming] = useState<{ readonly ready: boolean } | null>(null);
  const [posted, setPosted] = useState<string | null>(null);
  const shown = preview.data;
  const url = view.pullRequest?.url ?? posted ?? shown?.existing?.url ?? null;
  const draft = view.pullRequest?.draft ?? shown?.existing?.draft ?? null;
  const gate = url === null ? null : gateWord(view);
  const offered = view.pass.state === PassState.Open && shown?.offered === true;
  const pushFailed = view.notices.some((notice) => notice.kind === PassNoticeKind.PrNotOpened);
  if (url === null && !offered && opening.error === null) return null;
  const send = (ready: boolean) => {
    opening
      .mutateAsync({ passId: view.pass.id, ready })
      .then((opened) => {
        setPosted(opened.url);
      })
      .catch(() => {
        // The failure is said from `opening.error`.
      });
  };
  const open = (ready: boolean) => {
    if (shown !== undefined && aheadLine(view.pass.returnBranch, shown) !== null)
      setConfirming({ ready });
    else send(ready);
  };
  const markReady = offered && url !== null && draft === true;
  const pushNow = offered && url !== null && pushFailed;
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
      {url === null && offered ? (
        <Group gap={0} wrap="nowrap">
          <Button
            size="xs"
            loading={opening.isPending}
            style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
            onClick={() => {
              open(true);
            }}
          >
            Open PR
          </Button>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon
                variant="filled"
                size={30}
                disabled={opening.isPending}
                aria-label="More ways to open the pull request"
                style={{
                  borderTopLeftRadius: 0,
                  borderBottomLeftRadius: 0,
                  borderLeft: '1px solid var(--mantine-color-body)',
                }}
              >
                <IconChevronDown size={14} stroke={1.5} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <MenuAction
                label="Open as Draft"
                byline="Reviewers aren't asked until you mark it ready."
                onClick={() => {
                  open(false);
                }}
              />
            </Menu.Dropdown>
          </Menu>
        </Group>
      ) : null}
      {markReady || pushNow ? (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              loading={opening.isPending}
              aria-label="Pull request actions"
            >
              <IconChevronDown size={14} stroke={1.5} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {markReady ? (
              <MenuAction
                label="Mark Ready for Review"
                byline="It is no longer a draft, so reviewers are asked."
                onClick={() => {
                  send(true);
                }}
              />
            ) : null}
            {pushNow ? (
              <MenuAction
                label="Push Now"
                byline="The last push did not finish: push the committed pages again."
                onClick={() => {
                  send(false);
                }}
              />
            ) : null}
          </Menu.Dropdown>
        </Menu>
      ) : null}
      {confirming !== null && shown?.offered === true ? (
        <OpenPullRequestConfirm
          view={view}
          preview={shown}
          ready={confirming.ready}
          onClose={() => {
            setConfirming(null);
          }}
          onOpened={setPosted}
        />
      ) : null}
    </Group>
  );
}
