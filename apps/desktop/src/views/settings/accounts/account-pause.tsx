import { AccountPauseReason, type AccountDto, type AccountPauseDto } from '@10db/contracts';
import { Alert, Badge, Button, Group, Stack, Text } from '@mantine/core';
import { useAccountPauses, useResumeAccount } from '../../../daemon/account-queries';

const MOMENT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** A pause's start or end as the builder reads it, in their own time zone. */
export function formatMoment(iso: string): string {
  return MOMENT.format(new Date(iso));
}

const REASON_LABEL: Readonly<Record<AccountPauseReason, string>> = {
  [AccountPauseReason.Refused]: 'Sessions refused',
  [AccountPauseReason.MonthlyCap]: 'Monthly cap reached',
  [AccountPauseReason.UsageLimit]: 'Usage limit reached',
};

/** Only a usage-limit pause ends by itself; the other two wait until the builder lifts them. */
function canResume(pause: AccountPauseDto): boolean {
  switch (pause.reason) {
    case AccountPauseReason.Refused:
    case AccountPauseReason.MonthlyCap:
      return true;
    case AccountPauseReason.UsageLimit:
      return false;
  }
}

function endText(pause: AccountPauseDto): string {
  if (pause.until !== null) return `, until ${formatMoment(pause.until)}`;
  return pause.reason === AccountPauseReason.Refused ? ', until it is resumed' : '';
}

/**
 * The account's pause, if it has one: why, since when and until when, with a Resume for a refused or
 * monthly-cap pause. A usage-limit pause shows when it ends and offers none.
 */
export function AccountPause({ account }: { readonly account: AccountDto }) {
  const pauses = useAccountPauses();
  const resume = useResumeAccount();
  const pause = pauses.data?.find((p) => p.accountId === account.id);
  if (!pause) return null;
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Badge size="sm" variant="light" color="yellow">
          Paused
        </Badge>
        <Text size="xs" c="dimmed">
          {REASON_LABEL[pause.reason]} since {formatMoment(pause.since)}
          {endText(pause)}
        </Text>
        {canResume(pause) ? (
          <Button
            size="compact-xs"
            variant="default"
            aria-label={`Resume ${account.label}`}
            loading={resume.isPending}
            onClick={() => {
              resume.mutate(account.id);
            }}
          >
            Resume
          </Button>
        ) : null}
      </Group>
      {resume.isError ? (
        <Alert color="red" role="alert">
          {resume.error.message}
        </Alert>
      ) : null}
    </Stack>
  );
}
