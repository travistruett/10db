import type { GithubLoginEndedData, GithubStatusDto } from '@10db/contracts';
import { Button, Group, Skeleton, Text } from '@mantine/core';
import { IconBrandGithub } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import {
  useGithubLoginEnd,
  useGithubStatus,
  useRecheckGithub,
} from '../../../daemon/github-queries';
import { ConnectionStatus, ConnectionTone } from '../connection-status';
import { GithubSignIn } from './github-sign-in';
import { IntegrationCard } from './integration-card';

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

function Header({
  status,
  justNow,
}: {
  readonly status: GithubStatusDto;
  readonly justNow: boolean;
}) {
  switch (status.state) {
    case 'signed_in':
      return (
        <Group gap="xs" wrap="nowrap">
          <ConnectionStatus
            tone={ConnectionTone.Works}
            label={`Signed in as ${status.login ?? 'GitHub'}`}
          />
          {justNow ? (
            <Text size="xs" c="dimmed">
              just now
            </Text>
          ) : null}
        </Group>
      );
    case 'signed_out':
      return <ConnectionStatus tone={ConnectionTone.NeedsYou} label="Not signed in" />;
    case 'not_installed':
      return <ConnectionStatus tone={ConnectionTone.NeedsYou} label="gh isn't installed" />;
    case 'unreachable':
      return <ConnectionStatus tone={ConnectionTone.NeedsYou} label="Couldn't reach GitHub" />;
  }
}

/** Settings › Integrations › GitHub: the gh login 10db opens pull requests and watches checks with. */
export function GithubCard() {
  const query = useGithubStatus();
  const recheck = useRecheckGithub();
  const end = useGithubLoginEnd();
  const status = query.data;
  const justNow = useJustSignedIn(status, end);
  const checkAgain = (
    <Button
      size="xs"
      variant="default"
      loading={recheck.isPending}
      onClick={() => {
        recheck.mutate();
      }}
    >
      Check Again
    </Button>
  );
  const canSignIn =
    status !== undefined &&
    (status.signingIn !== null || status.state === 'signed_in' || status.state === 'signed_out');
  // The card appears once its state is read, so a link's focus lands on its controls.
  if (!status && !query.isError) return <Skeleton height={160} radius="md" />;
  return (
    <IntegrationCard
      mark={<IconBrandGithub size={20} stroke={1.5} aria-hidden />}
      name="GitHub"
      focusName="github"
      status={
        status ? (
          <Header status={status} justNow={justNow} />
        ) : (
          <ConnectionStatus tone={ConnectionTone.NeedsYou} label="Couldn't read this" />
        )
      }
      purpose="Opens pull requests, watches their checks, and finds new 10db builds."
      withoutIt="Pull requests, CI checks and self-update stop; projects can still commit directly."
    >
      {status?.state === 'signed_in' && !status.signingIn ? (
        <Text size="xs" c="dimmed">
          This is gh's own login, the same one your terminal uses.
        </Text>
      ) : null}
      {status?.state === 'not_installed' && !status.signingIn ? (
        <Text size="sm">
          {`10db looks for gh in ${INSTALL_PREFIXES}. Install it with Homebrew (brew install gh), then press Check Again.`}
        </Text>
      ) : null}
      {/* One Sign In for every state that can sign in, so a running one keeps its state across them. */}
      {canSignIn ? (
        <GithubSignIn
          label={status.state === 'signed_in' ? 'Switch Account' : 'Sign In'}
          filled={status.state !== 'signed_in'}
          extra={checkAgain}
        />
      ) : status ? (
        <Group>{checkAgain}</Group>
      ) : null}
      {recheck.isError ? (
        <Text size="xs" c="dimmed">
          {recheck.error.message}
        </Text>
      ) : null}
    </IntegrationCard>
  );
}
