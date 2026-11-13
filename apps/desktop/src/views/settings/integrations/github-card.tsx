import type { GithubStatusDto } from '@10db/contracts';
import { Button, Group, Text } from '@mantine/core';
import { IconBrandGithub } from '@tabler/icons-react';
import {
  useGithubLoginEnd,
  useGithubStatus,
  useRecheckGithub,
} from '../../../daemon/github-queries';
import { ConnectionStatus, ConnectionTone } from '../connection-status';
import { GithubSignIn } from './github-sign-in';
import { IntegrationCard } from './integration-card';

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
  return (
    <IntegrationCard
      mark={<IconBrandGithub size={20} stroke={1.5} aria-hidden />}
      name="GitHub"
      focusName="github"
      status={
        status ? (
          <Header status={status} justNow={end?.ok === true} />
        ) : query.isError ? (
          <ConnectionStatus tone={ConnectionTone.NeedsYou} label="Couldn't read this" />
        ) : (
          <Text size="sm" c="dimmed">
            Checking…
          </Text>
        )
      }
      purpose="Opens pull requests, watches their checks, and finds new 10db builds."
      withoutIt="Pull requests, CI checks and self-update stop; projects can still commit directly."
    >
      {status?.state === 'signed_in' ? (
        <>
          <Text size="xs" c="dimmed">
            This is gh's own login, the same one your terminal uses.
          </Text>
          <GithubSignIn label="Switch Account" filled={false} extra={checkAgain} />
        </>
      ) : null}
      {status?.state === 'signed_out' ? (
        <GithubSignIn label="Sign In" filled extra={checkAgain} />
      ) : null}
      {status?.state === 'not_installed' ? (
        <>
          <Text size="sm">
            {`10db looks for gh in ${INSTALL_PREFIXES}. Install it with Homebrew (brew install gh), then press Check Again.`}
          </Text>
          <Group>{checkAgain}</Group>
        </>
      ) : null}
      {status?.state === 'unreachable' ? <Group>{checkAgain}</Group> : null}
      {recheck.isError ? (
        <Text size="xs" c="dimmed">
          {recheck.error.message}
        </Text>
      ) : null}
    </IntegrationCard>
  );
}
