import { Button, Code, Group, Stack, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import {
  useCancelGithubSignin,
  useGithubLoginEnd,
  useGithubStatus,
  useStartGithubSignin,
} from '../../../daemon/github-queries';
import { openSignInPage } from '../../../desktop/tauri';

const PAGE_NOT_OPENED =
  'The browser did not open the page. Open github.com/login/device yourself and enter the code.';

/** The one-time code gh printed, the page to enter it on, and the ways to wait for or leave the sign-in. */
function Waiting({ code, url }: { readonly code: string; readonly url: string }) {
  const cancel = useCancelGithubSignin();
  const [copied, setCopied] = useState(false);
  const [openFailure, setOpenFailure] = useState(false);
  return (
    <Stack gap="xs">
      <Group gap="sm" wrap="nowrap">
        <Code fz="xl" fw={600} style={{ letterSpacing: '0.08em' }}>
          {code}
        </Code>
        <Button
          size="xs"
          variant="default"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        Waiting for you to approve in the browser…
      </Text>
      {openFailure ? (
        <Text size="xs" c="dimmed">
          {PAGE_NOT_OPENED}
        </Text>
      ) : null}
      <Group gap="sm">
        <Button
          size="xs"
          variant="default"
          onClick={() => {
            setOpenFailure(false);
            openSignInPage(url).catch(() => {
              setOpenFailure(true);
            });
          }}
        >
          Open Page Again
        </Button>
        <Button
          size="xs"
          variant="default"
          loading={cancel.isPending}
          onClick={() => {
            cancel.mutate();
          }}
        >
          Cancel
        </Button>
      </Group>
      {cancel.isError ? (
        <Text size="xs" c="dimmed">
          {cancel.error.message}
        </Text>
      ) : null}
    </Stack>
  );
}

/**
 * GitHub's Sign In: the button that runs `gh auth login` through the daemon, and, while it waits for the
 * builder, the one-time code with Copy, Open Page Again and Cancel in place of the buttons. A screen mounted
 * mid-sign-in restores the wait from the status. `extra` sits beside the button when no sign-in waits.
 * gh's own message about a sign-in that did not finish stays beside the button for another try.
 */
export function GithubSignIn({
  label,
  filled,
  extra,
}: {
  readonly label: 'Sign In' | 'Switch Account';
  /** The primary action of its surface: a filled button. */
  readonly filled: boolean;
  readonly extra?: ReactNode;
}) {
  const status = useGithubStatus().data;
  const start = useStartGithubSignin();
  const end = useGithubLoginEnd();
  const signingIn = status?.signingIn ?? null;
  const failure = start.isError
    ? start.error.message
    : end !== null && !end.ok && !end.cancelled
      ? end.message
      : null;
  const pageNotOpened = start.data?.opened === false && signingIn !== null;
  return (
    <Stack gap="xs">
      <div aria-live="polite">
        {signingIn !== null ? (
          <Waiting code={signingIn.code} url={signingIn.url} />
        ) : failure ? (
          <Text size="sm" c="dimmed">
            {failure}
          </Text>
        ) : null}
        {pageNotOpened ? (
          <Text size="xs" c="dimmed">
            {PAGE_NOT_OPENED}
          </Text>
        ) : null}
      </div>
      {signingIn === null ? (
        <Group gap="sm">
          <Button
            size="xs"
            variant={filled ? 'filled' : 'default'}
            loading={start.isPending}
            onClick={() => {
              start.mutate();
            }}
          >
            {label}
          </Button>
          {extra}
        </Group>
      ) : null}
    </Stack>
  );
}
