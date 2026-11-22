import type { GithubLoginEndedData, GithubStatusDto } from '@10db/contracts';
import { ActionIcon, Button, Menu, Skeleton, Text } from '@mantine/core';
import { IconBrandGithub, IconDots } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import {
  useGithubLoginEnd,
  useGithubStatus,
  useRecheckGithub,
  useStartGithubSignin,
} from '../../../daemon/github-queries';
import { GithubSignIn } from './github-sign-in';
import { IntegrationCard, StateText } from './integration-card';

/** How long a fresh sign-in says "just now". */
const JUST_NOW_MS = 60_000;

/**
 * Whether the status shows the login a sign-in just finished: from the first signed-in status after the
 * sign-in ended until another check moves `checkedAt` on, or a minute passes.
 */
function useJustSignedIn(
  status: GithubStatusDto | undefined,
  end: GithubLoginEndedData | null,
): boolean {
  const [seen, setSeen] = useState<{
    readonly end: GithubLoginEndedData;
    readonly checkedAt: string;
  } | null>(null);
  const [expired, setExpired] = useState<GithubLoginEndedData | null>(null);
  // Derived while rendering, so the first signed-in status after the end is the one remembered.
  if (
    end?.ok === true &&
    status?.state === 'signed_in' &&
    status.signingIn === null &&
    seen?.end !== end
  )
    setSeen({ end, checkedAt: status.checkedAt });
  useEffect(() => {
    if (seen === null) return;
    const timer = setTimeout(() => {
      setExpired(seen.end);
    }, JUST_NOW_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [seen]);
  return (
    seen !== null &&
    seen.end === end &&
    status?.checkedAt === seen.checkedAt &&
    expired !== seen.end
  );
}

const INSTALL_PREFIXES = '/opt/homebrew/bin, /usr/local/bin and /usr/bin';

/** The card's state line, in words. */
function stateOf(status: GithubStatusDto): string {
  switch (status.state) {
    case 'signed_in':
      return `Signed in as ${status.login ?? 'GitHub'}`;
    case 'signed_out':
      return 'Not signed in.';
    case 'not_installed':
      return `gh isn't installed. 10db looks for it in ${INSTALL_PREFIXES}; install it with Homebrew (brew install gh), then Check again.`;
    case 'unreachable':
      return "Couldn't reach GitHub.";
  }
}

/** Settings › Integrations › GitHub: the gh login 10db opens pull requests and watches checks with. */
export function GithubCard() {
  const query = useGithubStatus();
  const recheck = useRecheckGithub();
  const start = useStartGithubSignin();
  const end = useGithubLoginEnd();
  const status = query.data;
  const justNow = useJustSignedIn(status, end);
  const canSignIn =
    status !== undefined &&
    (status.signingIn !== null || status.state === 'signed_in' || status.state === 'signed_out');
  // The card appears once its state is read, so a link's focus lands on its controls.
  if (!status && !query.isError) return <Skeleton height={90} radius="md" />;
  return (
    <IntegrationCard
      mark={<IconBrandGithub size={20} stroke={1.5} aria-hidden />}
      name="GitHub"
      focusName="github"
      control={
        status?.state === 'signed_out' && status.signingIn === null ? (
          <Button
            size="xs"
            loading={start.isPending}
            onClick={() => {
              start.mutate();
            }}
          >
            Sign In
          </Button>
        ) : status ? (
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" aria-label="GitHub options">
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {canSignIn && status.signingIn === null ? (
                <Menu.Item
                  onClick={() => {
                    start.mutate();
                  }}
                >
                  {status.state === 'signed_in' ? 'Switch Account' : 'Sign In'}
                </Menu.Item>
              ) : null}
              <Menu.Item
                onClick={() => {
                  recheck.mutate();
                }}
              >
                Check Again
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        ) : undefined
      }
    >
      <StateText>
        {status ? stateOf(status) : "Couldn't read this."}
        {justNow ? ' · just now' : ''}
      </StateText>
      {/* The sign-in wait (code, Open Page Again, Cancel) and gh's own failure line, whichever way it started. */}
      {canSignIn ? <GithubSignIn label="Sign In" filled={false} hideButton /> : null}
      {recheck.isError ? (
        <Text size="xs" c="dimmed">
          {recheck.error.message}
        </Text>
      ) : null}
    </IntegrationCard>
  );
}
